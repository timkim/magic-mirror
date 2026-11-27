//! Offscreen wgpu renderer (mirrors src/render/renderer.ts) using the same WGSL shaders.
//! The device and scene stay loaded between frames; animation frames upload only what moved.

use crate::hdr::Environment;
use crate::scene::{Grid, GridBox};
use crate::settings::{Frame, Post};
use wgpu::util::DeviceExt;

const PATHTRACE: &str = include_str!(concat!(env!("OUT_DIR"), "/pathtrace.wgsl"));
const PRESENT: &str = include_str!(concat!(env!("OUT_DIR"), "/present.wgsl"));
const BLOOM: &str = include_str!(concat!(env!("OUT_DIR"), "/bloom.wgsl"));
const DENOISE: &str = include_str!(concat!(env!("OUT_DIR"), "/denoise.wgsl"));
const DENOISE_PASSES: usize = 5;
const PARAMS_BYTES: u64 = 18 * 16;

pub struct Renderer {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub adapter_name: String,
    trace: wgpu::ComputePipeline,
    present: wgpu::RenderPipeline,
    bloom_prep: wgpu::ComputePipeline,
    bloom_blur: wgpu::ComputePipeline,
    params: wgpu::Buffer,
    post: wgpu::Buffer,
    bloom_uniforms: [wgpu::Buffer; 3],
    materials: wgpu::Buffer,
    sampler: wgpu::Sampler,
    /// Voxel bricks and the brick map pointing into them (see scene::Grid).
    pool: Option<wgpu::Buffer>,
    brick_tex: Option<wgpu::Texture>,
    env_tex: wgpu::Texture,
    env_table: wgpu::Buffer,
    env_sample: [u32; 2],
    accum: Option<wgpu::Buffer>,
    // Denoiser (see src/render/shaders/denoise.wgsl.ts): first-hit guides and two ping-pong buffers.
    feat: Option<wgpu::Buffer>,
    ping_a: Option<wgpu::Buffer>,
    ping_b: Option<wgpu::Buffer>,
    dn_layout: wgpu::BindGroupLayout,
    dn_prep: wgpu::ComputePipeline,
    dn_atrous: wgpu::ComputePipeline,
    dn_finish: wgpu::ComputePipeline,
    dn_uniforms: Vec<wgpu::Buffer>,
    bloom_a: Option<wgpu::Texture>,
    bloom_b: Option<wgpu::Texture>,
    target: Option<wgpu::Texture>,
    pub width: u32,
    pub height: u32,
    pub samples: u32,
    grid_origin: [i32; 3],
    grid_dims: [usize; 3],
}

fn shader(device: &wgpu::Device, label: &str, code: &str) -> wgpu::ShaderModule {
    device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(label), source: wgpu::ShaderSource::Wgsl(code.into()) })
}

impl Renderer {
    pub fn new() -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))
        .map_err(|e| format!("no GPU adapter: {e}"))?;
        let info = adapter.get_info();
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("magic-prism"),
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .map_err(|e| format!("can't open GPU device: {e}"))?;

        let pt = shader(&device, "pathtrace", PATHTRACE);
        let trace = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("pathtrace"),
            layout: None,
            module: &pt,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let pr = shader(&device, "present", PRESENT);
        let present = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("present"),
            layout: None,
            vertex: wgpu::VertexState { module: &pr, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: &pr,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())],
            }),
            multiview_mask: None,
            cache: None,
        });
        let bl = shader(&device, "bloom", BLOOM);
        let compute = |entry: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: None,
                module: &bl,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let bloom_prep = compute("prep");
        let bloom_blur = compute("blur");

        let storage = |binding: u32, read_only: bool| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only }, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let dn_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("denoise"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                storage(1, true),
                storage(2, true),
                storage(3, true),
                storage(4, false),
            ],
        });
        let dn_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("denoise"), bind_group_layouts: &[Some(&dn_layout)], ..Default::default() });
        let dn = shader(&device, "denoise", DENOISE);
        let dn_pipe = |entry: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&dn_pipeline_layout),
                module: &dn,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let (dn_prep, dn_atrous, dn_finish) = (dn_pipe("prep"), dn_pipe("atrous"), dn_pipe("finish"));

        let uniform = |size: u64| {
            device.create_buffer(&wgpu::BufferDescriptor { label: None, size, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false })
        };
        let params = uniform(PARAMS_BYTES);
        let post = uniform(32);
        let bloom_uniforms = [uniform(48), uniform(48), uniform(48)];
        let dn_uniforms = (0..DENOISE_PASSES + 2).map(|_| uniform(32)).collect();
        let materials = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("materials"),
            size: 256 * 64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let mut r = Renderer {
            env_tex: Self::make_env_texture(&device, &queue, 1, 1, &[0u16; 4]),
            env_table: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("env table"),
                contents: bytemuck::cast_slice(&[0f32; 4]),
                usage: wgpu::BufferUsages::STORAGE,
            }),
            device,
            queue,
            adapter_name: format!("{} ({:?})", info.name, info.backend),
            trace,
            present,
            bloom_prep,
            bloom_blur,
            params,
            post,
            bloom_uniforms,
            materials,
            sampler,
            pool: None,
            brick_tex: None,
            env_sample: [0, 0],
            accum: None,
            feat: None,
            ping_a: None,
            ping_b: None,
            dn_layout,
            dn_prep,
            dn_atrous,
            dn_finish,
            dn_uniforms,
            bloom_a: None,
            bloom_b: None,
            target: None,
            width: 0,
            height: 0,
            samples: 0,
            grid_origin: [0; 3],
            grid_dims: [1; 3],
        };
        r.samples = 0;
        Ok(r)
    }

    fn make_env_texture(device: &wgpu::Device, queue: &wgpu::Queue, w: u32, h: u32, data: &[u16]) -> wgpu::Texture {
        let t = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("environment"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            t.as_image_copy(),
            bytemuck::cast_slice(data),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 8), rows_per_image: Some(h) },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        t
    }

    /// Upload `data` (u32 per brick) into a sub-box of the brick map texture.
    fn write_map(&self, tex: &wgpu::Texture, origin: [usize; 3], size: [usize; 3], data: &[u32]) {
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: tex,
                mip_level: 0,
                origin: wgpu::Origin3d { x: origin[0] as u32, y: origin[1] as u32, z: origin[2] as u32 },
                aspect: wgpu::TextureAspect::All,
            },
            bytemuck::cast_slice(data),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size[0] as u32 * 4), rows_per_image: Some(size[1] as u32) },
            wgpu::Extent3d { width: size[0] as u32, height: size[1] as u32, depth_or_array_layers: size[2] as u32 },
        );
    }

    /// Make the GPU brick pool big enough for the grid (reallocating with room to grow) and
    /// upload either everything or just the given slots.
    fn upload_pool(&mut self, grid: &Grid, all: bool, slots: &[usize]) {
        let need = (grid.slots().max(1) * 512) as u64;
        let mut all = all;
        if self.pool.as_ref().is_none_or(|p| p.size() < need) {
            let size = (need * 3 / 2).max(1 << 20).div_ceil(4) * 4;
            self.pool = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("voxel bricks"),
                size,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
            all = true;
        }
        let pool = self.pool.as_ref().unwrap();
        if all {
            if !grid.pool.is_empty() {
                self.queue.write_buffer(pool, 0, &grid.pool);
            }
            return;
        }
        for &slot in slots {
            self.queue.write_buffer(pool, (slot * 512) as u64, &grid.pool[slot * 512..(slot + 1) * 512]);
        }
    }

    pub fn set_scene(&mut self, grid: &Grid, materials: &[f32]) -> Result<(), String> {
        let max = self.device.limits().max_texture_dimension_3d as usize;
        if grid.bdims.iter().any(|&n| n > max) {
            return Err(format!("scene is {:?} voxels; this GPU allows {} per axis", grid.dims, max * 8));
        }
        let [bx, by, bz] = grid.bdims;
        let bt = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("brick map"),
            size: wgpu::Extent3d { width: bx as u32, height: by as u32, depth_or_array_layers: bz as u32 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::R32Uint,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        self.write_map(&bt, [0; 3], grid.bdims, &grid.map);
        self.brick_tex = Some(bt);
        self.upload_pool(grid, true, &[]);
        self.grid_origin = grid.origin;
        self.grid_dims = grid.dims;
        self.queue.write_buffer(&self.materials, 0, bytemuck::cast_slice(materials));
        self.samples = 0;
        Ok(())
    }

    /// Re-upload only the bricks inside the changed regions of the grid passed to set_scene.
    pub fn update_regions(&mut self, grid: &Grid, boxes: &[GridBox]) {
        if self.brick_tex.is_none() || boxes.is_empty() {
            return;
        }
        let grew = self.pool.as_ref().is_none_or(|p| p.size() < (grid.slots() * 512) as u64);
        if grew {
            self.upload_pool(grid, true, &[]);
        }
        let [bx, by, _] = grid.bdims;
        for b in boxes {
            let lo = b.min.map(|v| v >> 3);
            let hi = [0, 1, 2].map(|i| (b.max[i] >> 3).min(grid.bdims[i] - 1));
            let bs = [0, 1, 2].map(|i| hi[i] - lo[i] + 1);
            let mut sub = vec![0u32; bs[0] * bs[1] * bs[2]];
            let mut slots = vec![];
            for k in 0..bs[2] {
                for j in 0..bs[1] {
                    let src = lo[0] + bx * (lo[1] + j + by * (lo[2] + k));
                    let row = &grid.map[src..src + bs[0]];
                    sub[bs[0] * (j + bs[1] * k)..][..bs[0]].copy_from_slice(row);
                    slots.extend(row.iter().filter(|&&m| m != 0).map(|&m| m as usize - 1));
                }
            }
            self.write_map(self.brick_tex.as_ref().unwrap(), lo, bs, &sub);
            if !grew {
                self.upload_pool(grid, false, &slots);
            }
        }
        self.samples = 0;
    }

    pub fn set_environment(&mut self, env: &Environment) {
        self.env_tex = Self::make_env_texture(&self.device, &self.queue, env.width, env.height, &env.data);
        self.env_table = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("env table"),
            contents: bytemuck::cast_slice(&env.table),
            usage: wgpu::BufferUsages::STORAGE,
        });
        self.env_sample = [env.sample_w, env.sample_h];
        self.samples = 0;
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width == self.width && height == self.height && self.accum.is_some() {
            return;
        }
        self.width = width;
        self.height = height;
        self.accum = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("accum"),
            size: width as u64 * height as u64 * 16,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        }));
        let px = width as u64 * height as u64;
        let buffer = |label: &str, size: u64| {
            Some(self.device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false }))
        };
        self.feat = buffer("denoise guides", px * 32);
        self.ping_a = buffer("denoise a", px * 16);
        self.ping_b = buffer("denoise b", px * 16);
        let (bw, bh) = (width.div_ceil(4).max(1), height.div_ceil(4).max(1));
        let tex = |label: &str, w: u32, h: u32, format: wgpu::TextureFormat, usage: wgpu::TextureUsages| {
            self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage,
                view_formats: &[],
            })
        };
        let bloom_usage = wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING;
        self.bloom_a = Some(tex("bloom a", bw, bh, wgpu::TextureFormat::Rgba16Float, bloom_usage));
        self.bloom_b = Some(tex("bloom b", bw, bh, wgpu::TextureFormat::Rgba16Float, bloom_usage));
        self.target = Some(tex("output", width, height, wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC));
        self.samples = 0;
    }

    fn params_bytes(&self, f: &Frame) -> Vec<u8> {
        let c = &f.camera;
        let l = &f.lighting;
        let mut fv = [0f32; 72];
        let put = |fv: &mut [f32; 72], slot: usize, v: [f64; 3], w: f64| {
            fv[slot * 4..slot * 4 + 4].copy_from_slice(&[v[0] as f32, v[1] as f32, v[2] as f32, w as f32]);
        };
        put(&mut fv, 0, c.position, if c.orthographic { 0.0 } else { c.aperture });
        put(&mut fv, 1, c.forward, c.focus_distance);
        put(&mut fv, 2, c.right, c.scale);
        put(&mut fv, 3, c.up, if c.orthographic { 1.0 } else { 0.0 });
        put(&mut fv, 4, l.sun_direction, l.sun_cos_radius);
        put(&mut fv, 5, l.sun_color, if l.sun_enabled { 1.0 } else { 0.0 });
        put(&mut fv, 6, l.sky_color, 0.0);
        put(&mut fv, 7, l.background.unwrap_or([0.0; 3]), if l.background.is_some() { 1.0 } else { 0.0 });
        put(&mut fv, 8, l.ground.unwrap_or([0.0; 3]), if l.ground.is_some() { 1.0 } else { 0.0 });
        put(&mut fv, 9, self.grid_origin.map(|v| v as f64), l.ground_height);
        put(&mut fv, 12, l.rayleigh, l.mie_density);
        put(&mut fv, 13, l.mie_color, l.mie_g);
        // HDR mode without an image falls back to the atmosphere.
        let mode = if l.sky_mode == 2 && self.env_sample[0] == 0 { 1 } else { l.sky_mode };
        fv[56..60].copy_from_slice(&[mode as f32, l.hdr_intensity as f32, l.hdr_rotation as f32, l.atmosphere_intensity as f32]);
        let radius = (self.grid_dims[0] as f64).hypot(self.grid_dims[1] as f64) / 2.0;
        fv[60..64].copy_from_slice(&[radius as f32, l.horizon_fade as f32, if l.sun_disk { 1.0 } else { 0.0 }, l.fog_g as f32]);
        put(&mut fv, 17, l.fog_color, l.fog_density);
        let mut bytes: Vec<u8> = bytemuck::cast_slice(&fv).to_vec();
        let u = |bytes: &mut Vec<u8>, at: usize, vals: [u32; 4]| bytes[at * 4..at * 4 + 16].copy_from_slice(bytemuck::cast_slice(&vals));
        let d = self.grid_dims;
        u(&mut bytes, 40, [d[0] as u32, d[1] as u32, d[2] as u32, self.samples]);
        u(&mut bytes, 44, [self.width, self.height, f.max_bounces, 1]);
        u(&mut bytes, 64, [self.env_sample[0], self.env_sample[1], if self.env_sample[0] > 0 { 1 } else { 0 }, 0]);
        bytes
    }

    fn trace_group(&self) -> wgpu::BindGroup {
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("trace"),
            layout: &self.trace.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.params.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.pool.as_ref().unwrap().as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&self.brick_tex.as_ref().unwrap().create_view(&Default::default())) },
                wgpu::BindGroupEntry { binding: 3, resource: self.materials.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: self.accum.as_ref().unwrap().as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(&self.env_tex.create_view(&Default::default())) },
                wgpu::BindGroupEntry { binding: 6, resource: self.env_table.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 7, resource: self.feat.as_ref().unwrap().as_entire_binding() },
            ],
        })
    }

    /// Trace `count` samples per pixel. Each sample is its own submission so its uniforms land in order.
    pub fn trace(&mut self, frame: &Frame, count: u32) {
        let group = self.trace_group();
        for _ in 0..count {
            self.queue.write_buffer(&self.params, 0, &self.params_bytes(frame));
            let mut enc = self.device.create_command_encoder(&Default::default());
            {
                let mut pass = enc.begin_compute_pass(&Default::default());
                pass.set_pipeline(&self.trace);
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups(self.width.div_ceil(8), self.height.div_ceil(8), 1);
            }
            self.queue.submit([enc.finish()]);
            self.samples += 1;
        }
    }

    /// Denoise the current average into ping_a (same passes as renderer.ts).
    fn encode_denoise(&self, enc: &mut wgpu::CommandEncoder, strength: f64) {
        let n = DENOISE_PASSES;
        for u in 0..n + 2 {
            let step = if u >= 1 && u <= n { (1u32 << (u - 1)) as f32 } else { 1.0 };
            let mut buf = [0u8; 32];
            buf[0..8].copy_from_slice(bytemuck::cast_slice(&[self.width, self.height]));
            buf[8..20].copy_from_slice(bytemuck::cast_slice(&[self.samples.max(1) as f32, step, strength as f32]));
            self.queue.write_buffer(&self.dn_uniforms[u], 0, &buf);
        }
        let (a, b) = (self.ping_a.as_ref().unwrap(), self.ping_b.as_ref().unwrap());
        let group = |u: usize, src: &wgpu::Buffer, dst: &wgpu::Buffer| {
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("denoise"),
                layout: &self.dn_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: self.dn_uniforms[u].as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: self.accum.as_ref().unwrap().as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: self.feat.as_ref().unwrap().as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: src.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 4, resource: dst.as_entire_binding() },
                ],
            })
        };
        let mut groups = vec![group(0, b, a)];
        let (mut from, mut to) = (a, b);
        for k in 0..n {
            groups.push(group(k + 1, from, to));
            std::mem::swap(&mut from, &mut to);
        }
        groups.push(group(n + 1, from, to));
        assert!(std::ptr::eq(to, a), "denoised result must land in ping_a");
        let wg = (self.width.div_ceil(8), self.height.div_ceil(8));
        let mut pass = enc.begin_compute_pass(&Default::default());
        pass.set_pipeline(&self.dn_prep);
        pass.set_bind_group(0, &groups[0], &[]);
        pass.dispatch_workgroups(wg.0, wg.1, 1);
        pass.set_pipeline(&self.dn_atrous);
        for g in &groups[1..=n] {
            pass.set_bind_group(0, g, &[]);
            pass.dispatch_workgroups(wg.0, wg.1, 1);
        }
        pass.set_pipeline(&self.dn_finish);
        pass.set_bind_group(0, &groups[n + 1], &[]);
        pass.dispatch_workgroups(wg.0, wg.1, 1);
    }

    fn encode_bloom(&self, enc: &mut wgpu::CommandEncoder, p: &Post, source: &wgpu::Buffer, samples: f32) {
        let (a, b) = (self.bloom_a.as_ref().unwrap(), self.bloom_b.as_ref().unwrap());
        let (bw, bh) = (a.width(), a.height());
        let r = p.bloom_scale * bh as f64 * 0.25;
        let (rx, ry) = (r * 2.0 * p.bloom_aspect, r * 2.0 * (1.0 - p.bloom_aspect));
        let write = |i: usize, radius: f64, dir: [f32; 2]| {
            let mut buf = [0u8; 48];
            buf[0..16].copy_from_slice(bytemuck::cast_slice(&[self.width, self.height, bw, bh]));
            buf[16..40].copy_from_slice(bytemuck::cast_slice(&[samples, p.exposure as f32, p.bloom_threshold as f32, radius as f32, dir[0], dir[1]]));
            self.queue.write_buffer(&self.bloom_uniforms[i], 0, &buf);
        };
        write(0, 0.0, [0.0, 0.0]);
        write(1, rx, [1.0, 0.0]);
        write(2, ry, [0.0, 1.0]);
        let view = |t: &wgpu::Texture| t.create_view(&Default::default());
        let prep = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.bloom_prep.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.bloom_uniforms[0].as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: source.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&view(a)) },
            ],
        });
        let blur = |u: &wgpu::Buffer, dst: &wgpu::Texture, src: &wgpu::Texture| {
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.bloom_blur.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: u.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&view(dst)) },
                    wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&view(src)) },
                ],
            })
        };
        let h = blur(&self.bloom_uniforms[1], b, a);
        let v = blur(&self.bloom_uniforms[2], a, b);
        let mut pass = enc.begin_compute_pass(&Default::default());
        let wg = (bw.div_ceil(8), bh.div_ceil(8));
        pass.set_pipeline(&self.bloom_prep);
        pass.set_bind_group(0, &prep, &[]);
        pass.dispatch_workgroups(wg.0, wg.1, 1);
        pass.set_pipeline(&self.bloom_blur);
        pass.set_bind_group(0, &h, &[]);
        pass.dispatch_workgroups(wg.0, wg.1, 1);
        pass.set_bind_group(0, &v, &[]);
        pass.dispatch_workgroups(wg.0, wg.1, 1);
    }

    /// Tone-map the current average and read it back as RGBA8 rows.
    pub fn read_pixels(&self, p: &Post) -> Vec<u8> {
        let target = self.target.as_ref().unwrap();
        let mut enc = self.device.create_command_encoder(&Default::default());
        let denoise = p.denoise > 0.0 && self.samples > 0;
        if denoise {
            self.encode_denoise(&mut enc, p.denoise);
        }
        // The denoised image is already an average; the raw one is a sum of samples.
        let (source, samples) = if denoise { (self.ping_a.as_ref().unwrap(), 1.0) } else { (self.accum.as_ref().unwrap(), self.samples.max(1) as f32) };
        if p.bloom_mix > 0.0 {
            self.encode_bloom(&mut enc, p, source, samples);
        }
        let mut buf = [0u8; 32];
        buf[0..8].copy_from_slice(bytemuck::cast_slice(&[self.width, self.height]));
        buf[8..16].copy_from_slice(bytemuck::cast_slice(&[samples, p.exposure as f32]));
        buf[16..20].copy_from_slice(bytemuck::bytes_of(&p.tonemap));
        buf[20..32].copy_from_slice(bytemuck::cast_slice(&[p.gamma as f32, p.vignette as f32, p.bloom_mix as f32]));
        self.queue.write_buffer(&self.post, 0, &buf);
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("present"),
            layout: &self.present.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.post.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: source.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&self.bloom_a.as_ref().unwrap().create_view(&Default::default())) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        let view = target.create_view(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("present"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.present);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }
        let row = (self.width * 4).div_ceil(256) * 256;
        let read = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: row as u64 * self.height as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        enc.copy_texture_to_buffer(
            target.as_image_copy(),
            wgpu::TexelCopyBufferInfo { buffer: &read, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(self.height) } },
            wgpu::Extent3d { width: self.width, height: self.height, depth_or_array_layers: 1 },
        );
        self.queue.submit([enc.finish()]);
        read.slice(..).map_async(wgpu::MapMode::Read, |r| r.expect("map readback"));
        self.device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("GPU poll");
        let data = read.slice(..).get_mapped_range().expect("map readback");
        let mut out = vec![0u8; (self.width * self.height * 4) as usize];
        for y in 0..self.height as usize {
            let w = self.width as usize * 4;
            out[y * w..(y + 1) * w].copy_from_slice(&data[y * row as usize..y * row as usize + w]);
        }
        out
    }

    /// Block until queued GPU work is done (keeps progress reporting honest).
    pub fn wait(&self) {
        let _ = self.device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None });
    }
}

pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = vec![];
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().map_err(|e| e.to_string())?;
        w.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}
