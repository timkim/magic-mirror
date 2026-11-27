//! Offscreen wgpu renderer (mirrors src/render/renderer.ts) using the same WGSL shaders.
//! The device and scene stay loaded between frames; animation frames upload only what moved.

use crate::hdr::Environment;
use crate::scene::{Grid, GridBox};
use crate::settings::{Frame, Post};
use wgpu::util::DeviceExt;

const PATHTRACE: &str = include_str!(concat!(env!("OUT_DIR"), "/pathtrace.wgsl"));
const PRESENT: &str = include_str!(concat!(env!("OUT_DIR"), "/present.wgsl"));
const BLOOM: &str = include_str!(concat!(env!("OUT_DIR"), "/bloom.wgsl"));
const BRICK: usize = 8;
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
    voxel_tex: Option<wgpu::Texture>,
    brick_tex: Option<wgpu::Texture>,
    bricks: Vec<u8>,
    env_tex: wgpu::Texture,
    env_table: wgpu::Buffer,
    env_sample: [u32; 2],
    accum: Option<wgpu::Buffer>,
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
            label: Some("magic-mirror"),
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

        let uniform = |size: u64| {
            device.create_buffer(&wgpu::BufferDescriptor { label: None, size, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false })
        };
        let params = uniform(PARAMS_BYTES);
        let post = uniform(32);
        let bloom_uniforms = [uniform(48), uniform(48), uniform(48)];
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
            voxel_tex: None,
            brick_tex: None,
            bricks: vec![],
            env_sample: [0, 0],
            accum: None,
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

    fn texture_3d(&self, label: &str, size: [usize; 3]) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: size[0] as u32, height: size[1] as u32, depth_or_array_layers: size[2] as u32 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::R8Uint,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        })
    }

    fn write_3d(&self, tex: &wgpu::Texture, origin: [usize; 3], size: [usize; 3], data: &[u8]) {
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: tex,
                mip_level: 0,
                origin: wgpu::Origin3d { x: origin[0] as u32, y: origin[1] as u32, z: origin[2] as u32 },
                aspect: wgpu::TextureAspect::All,
            },
            data,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size[0] as u32), rows_per_image: Some(size[1] as u32) },
            wgpu::Extent3d { width: size[0] as u32, height: size[1] as u32, depth_or_array_layers: size[2] as u32 },
        );
    }

    pub fn set_scene(&mut self, grid: &Grid, materials: &[f32]) -> Result<(), String> {
        let max = self.device.limits().max_texture_dimension_3d as usize;
        if grid.dims.iter().any(|&n| n > max) {
            return Err(format!("scene is {:?} voxels; this GPU allows {max} per axis", grid.dims));
        }
        let [dx, dy, dz] = grid.dims;
        let vt = self.texture_3d("voxels", grid.dims);
        self.write_3d(&vt, [0; 3], grid.dims, &grid.cells);
        let (bx, by, bz) = (dx.div_ceil(BRICK), dy.div_ceil(BRICK), dz.div_ceil(BRICK));
        let mut bricks = vec![0u8; bx * by * bz];
        for z in 0..dz {
            for y in 0..dy {
                let row = dx * (y + dy * z);
                let brow = bx * ((y >> 3) + by * (z >> 3));
                for x in 0..dx {
                    if grid.cells[row + x] != 0 {
                        bricks[brow + (x >> 3)] = 1;
                    }
                }
            }
        }
        let bt = self.texture_3d("bricks", [bx, by, bz]);
        self.write_3d(&bt, [0; 3], [bx, by, bz], &bricks);
        self.voxel_tex = Some(vt);
        self.brick_tex = Some(bt);
        self.bricks = bricks;
        self.grid_origin = grid.origin;
        self.grid_dims = grid.dims;
        self.queue.write_buffer(&self.materials, 0, bytemuck::cast_slice(materials));
        self.samples = 0;
        Ok(())
    }

    /// Re-upload only the changed regions of the grid passed to set_scene.
    pub fn update_regions(&mut self, grid: &Grid, boxes: &[GridBox]) {
        let (Some(vt), Some(bt)) = (&self.voxel_tex, &self.brick_tex) else { return };
        let [dx, dy, dz] = grid.dims;
        let (bx, by) = (dx.div_ceil(BRICK), dy.div_ceil(BRICK));
        for b in boxes {
            let size = [0, 1, 2].map(|i| b.max[i] - b.min[i] + 1);
            let mut sub = vec![0u8; size[0] * size[1] * size[2]];
            for z in 0..size[2] {
                for y in 0..size[1] {
                    let src = b.min[0] + dx * (b.min[1] + y + dy * (b.min[2] + z));
                    let dst = size[0] * (y + size[1] * z);
                    sub[dst..dst + size[0]].copy_from_slice(&grid.cells[src..src + size[0]]);
                }
            }
            self.write_3d(vt, b.min, size, &sub);
            let lo = b.min.map(|v| v >> 3);
            let hi = b.max.map(|v| v >> 3);
            let bs = [0, 1, 2].map(|i| hi[i] - lo[i] + 1);
            let mut bsub = vec![0u8; bs[0] * bs[1] * bs[2]];
            for k in lo[2]..=hi[2] {
                for j in lo[1]..=hi[1] {
                    for i in lo[0]..=hi[0] {
                        let mut occ = 0u8;
                        'scan: for z in k * BRICK..((k + 1) * BRICK).min(dz) {
                            for y in j * BRICK..((j + 1) * BRICK).min(dy) {
                                let row = dx * (y + dy * z);
                                for x in i * BRICK..((i + 1) * BRICK).min(dx) {
                                    if grid.cells[row + x] != 0 {
                                        occ = 1;
                                        break 'scan;
                                    }
                                }
                            }
                        }
                        self.bricks[i + bx * (j + by * k)] = occ;
                        bsub[(i - lo[0]) + bs[0] * ((j - lo[1]) + bs[1] * (k - lo[2]))] = occ;
                    }
                }
            }
            self.write_3d(bt, lo, bs, &bsub);
        }
        if !boxes.is_empty() {
            self.samples = 0;
        }
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
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&self.voxel_tex.as_ref().unwrap().create_view(&Default::default())) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&self.brick_tex.as_ref().unwrap().create_view(&Default::default())) },
                wgpu::BindGroupEntry { binding: 3, resource: self.materials.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: self.accum.as_ref().unwrap().as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(&self.env_tex.create_view(&Default::default())) },
                wgpu::BindGroupEntry { binding: 6, resource: self.env_table.as_entire_binding() },
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

    fn encode_bloom(&self, enc: &mut wgpu::CommandEncoder, p: &Post) {
        let (a, b) = (self.bloom_a.as_ref().unwrap(), self.bloom_b.as_ref().unwrap());
        let (bw, bh) = (a.width(), a.height());
        let r = p.bloom_scale * bh as f64 * 0.25;
        let (rx, ry) = (r * 2.0 * p.bloom_aspect, r * 2.0 * (1.0 - p.bloom_aspect));
        let write = |i: usize, radius: f64, dir: [f32; 2]| {
            let mut buf = [0u8; 48];
            buf[0..16].copy_from_slice(bytemuck::cast_slice(&[self.width, self.height, bw, bh]));
            buf[16..40].copy_from_slice(bytemuck::cast_slice(&[self.samples.max(1) as f32, p.exposure as f32, p.bloom_threshold as f32, radius as f32, dir[0], dir[1]]));
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
                wgpu::BindGroupEntry { binding: 1, resource: self.accum.as_ref().unwrap().as_entire_binding() },
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
        if p.bloom_mix > 0.0 {
            self.encode_bloom(&mut enc, p);
        }
        let mut buf = [0u8; 32];
        buf[0..8].copy_from_slice(bytemuck::cast_slice(&[self.width, self.height]));
        buf[8..16].copy_from_slice(bytemuck::cast_slice(&[self.samples.max(1) as f32, p.exposure as f32]));
        buf[16..20].copy_from_slice(bytemuck::bytes_of(&p.tonemap));
        buf[20..32].copy_from_slice(bytemuck::cast_slice(&[p.gamma as f32, p.vignette as f32, p.bloom_mix as f32]));
        self.queue.write_buffer(&self.post, 0, &buf);
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("present"),
            layout: &self.present.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.post.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.accum.as_ref().unwrap().as_entire_binding() },
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
