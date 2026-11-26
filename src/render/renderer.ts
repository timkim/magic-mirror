// GPU side of Magic Mirror. Independent of the DOM: it takes a GPUDevice and renders into
// any texture view, so the same code runs in the browser and in headless render workers.

import { PATHTRACE_WGSL } from './shaders/pathtrace.wgsl';
import { PRESENT_WGSL } from './shaders/present.wgsl';
import { BLOOM_WGSL } from './shaders/bloom.wgsl';
import { buildMaterialTable } from './materials';
import type { GridBox, VoxelGrid } from '../vox/scene';
import type { VoxDict } from '../vox/types';

export type Vec3 = [number, number, number];

export interface CameraParams {
  position: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  /** tan(fov/2) for perspective, half-height for orthographic. */
  scale: number;
  orthographic: boolean;
  aperture: number;
  focusDistance: number;
}

export type SkyMode = 'uniform' | 'atmosphere' | 'hdr';

export interface LightingParams {
  sunDirection: Vec3; // towards the sun
  sunCosRadius: number;
  sunColor: Vec3; // already multiplied by intensity
  sunEnabled: boolean;
  sunDisk: boolean;
  skyMode: SkyMode;
  skyColor: Vec3; // uniform sky radiance
  rayleigh: Vec3; // atmosphere Rayleigh colour × density
  mieColor: Vec3;
  mieDensity: number;
  mieG: number;
  atmosphereIntensity: number;
  hdrIntensity: number;
  hdrRotation: number; // radians
  background: Vec3 | null; // null = show the sky behind the scene
  ground: Vec3 | null; // null = no ground plane
  groundHeight: number;
  horizonFade: number; // 0 = ground runs to the horizon
  fogColor: Vec3;
  fogDensity: number; // extinction per voxel; 0 = no fog
  fogG: number;
}

export interface PostParams {
  exposure: number; // linear multiplier
  tonemap: 'none' | 'aces' | 'reinhard';
  gamma: number;
  vignette: number;
  bloomMix: number;
  bloomScale: number; // blur size relative to image height
  bloomAspect: number; // 0.5 = round; higher = wider
  bloomThreshold: number;
}

export interface FrameParams {
  camera: CameraParams;
  lighting: LightingParams;
  maxBounces: number;
}

const BRICK = 8;
const PARAMS_BYTES = 18 * 16;

export class Renderer {
  readonly device: GPUDevice;
  private format: GPUTextureFormat;
  private tracePipeline: GPUComputePipeline;
  private presentPipeline: GPURenderPipeline;
  private bloomPrep: GPUComputePipeline;
  private bloomBlur: GPUComputePipeline;
  private params: GPUBuffer;
  private post: GPUBuffer;
  private bloomUniforms: GPUBuffer[];
  private materials: GPUBuffer;
  private sampler: GPUSampler;
  private voxelTex: GPUTexture | null = null;
  private brickTex: GPUTexture | null = null;
  private envTex: GPUTexture;
  private envTable: GPUBuffer;
  private envSampleSize: [number, number] = [0, 0];
  private accum: GPUBuffer | null = null;
  private bloomA: GPUTexture | null = null;
  private bloomB: GPUTexture | null = null;
  private traceGroup: GPUBindGroup | null = null;
  private presentGroup: GPUBindGroup | null = null;
  private bloomGroups: GPUBindGroup[] = [];
  private grid: VoxelGrid | null = null;
  private bricks: Uint8Array | null = null;
  private frame: FrameParams | null = null;
  private staging: GPUBuffer[] = [];
  hasEnvironment = false;
  width = 0;
  height = 0;
  /** Samples accumulated per pixel since the last reset. */
  samples = 0;
  private seed = 1;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
    const traceShader = device.createShaderModule({ label: 'pathtrace', code: PATHTRACE_WGSL });
    this.tracePipeline = device.createComputePipeline({ label: 'pathtrace', layout: 'auto', compute: { module: traceShader, entryPoint: 'main' } });
    const presentShader = device.createShaderModule({ label: 'present', code: PRESENT_WGSL });
    this.presentPipeline = device.createRenderPipeline({
      label: 'present',
      layout: 'auto',
      vertex: { module: presentShader, entryPoint: 'vs' },
      fragment: { module: presentShader, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const bloomShader = device.createShaderModule({ label: 'bloom', code: BLOOM_WGSL });
    this.bloomPrep = device.createComputePipeline({ label: 'bloom-prep', layout: 'auto', compute: { module: bloomShader, entryPoint: 'prep' } });
    this.bloomBlur = device.createComputePipeline({ label: 'bloom-blur', layout: 'auto', compute: { module: bloomShader, entryPoint: 'blur' } });

    const U = GPUBufferUsage;
    this.params = device.createBuffer({ size: PARAMS_BYTES, usage: U.UNIFORM | U.COPY_DST });
    this.post = device.createBuffer({ size: 32, usage: U.UNIFORM | U.COPY_DST });
    this.bloomUniforms = [0, 1, 2].map(() => device.createBuffer({ size: 48, usage: U.UNIFORM | U.COPY_DST }));
    this.materials = device.createBuffer({ size: 256 * 64, usage: U.STORAGE | U.COPY_DST });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.envTex = this.makeEnvTexture(1, 1, new Uint16Array(4));
    this.envTable = this.makeEnvTable(new Float32Array(4));
  }

  /** Check shaders compiled; returns error messages (empty when fine). */
  static async shaderErrors(device: GPUDevice): Promise<string[]> {
    const errs: string[] = [];
    for (const [label, code] of [['pathtrace', PATHTRACE_WGSL], ['present', PRESENT_WGSL], ['bloom', BLOOM_WGSL]]) {
      const info = await device.createShaderModule({ label, code }).getCompilationInfo();
      for (const m of info.messages) if (m.type === 'error') errs.push(`${label}:${m.lineNum}:${m.linePos} ${m.message}`);
    }
    return errs;
  }

  setScene(grid: VoxelGrid, palette: Uint8Array, materials: Map<number, VoxDict>) {
    const d = this.device;
    const max = d.limits.maxTextureDimension3D;
    if (grid.dims.some((n) => n > max)) throw new Error(`Scene is ${grid.dims.join('×')} voxels; this GPU allows ${max} per axis.`);
    this.voxelTex?.destroy();
    this.brickTex?.destroy();
    this.grid = grid;

    const [dx, dy, dz] = grid.dims;
    this.voxelTex = d.createTexture({ size: [dx, dy, dz], dimension: '3d', format: 'r8uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: this.voxelTex }, grid.cells as Uint8Array<ArrayBuffer>, { bytesPerRow: dx, rowsPerImage: dy }, [dx, dy, dz]);

    const bx = Math.ceil(dx / BRICK), by = Math.ceil(dy / BRICK), bz = Math.ceil(dz / BRICK);
    const bricks = new Uint8Array(bx * by * bz);
    for (let z = 0; z < dz; z++)
      for (let y = 0; y < dy; y++) {
        const row = dx * (y + dy * z);
        const brow = bx * ((y >> 3) + by * (z >> 3));
        for (let x = 0; x < dx; x++) if (grid.cells[row + x]) bricks[brow + (x >> 3)] = 1;
      }
    this.bricks = bricks;
    this.brickTex = d.createTexture({ size: [bx, by, bz], dimension: '3d', format: 'r8uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: this.brickTex }, bricks, { bytesPerRow: bx, rowsPerImage: by }, [bx, by, bz]);

    d.queue.writeBuffer(this.materials, 0, buildMaterialTable(palette, materials) as Float32Array<ArrayBuffer>);
    this.rebind();
    this.reset();
  }

  /**
   * Re-upload only the changed parts of the grid set with setScene (same grid object,
   * e.g. after SceneBaker.setTime). Much faster than setScene for animation.
   */
  updateRegions(boxes: GridBox[]) {
    const g = this.grid, d = this.device;
    if (!g || !this.voxelTex || !this.brickTex || !this.bricks || boxes.length === 0) return;
    const [dx, dy] = g.dims;
    const bx = Math.ceil(g.dims[0] / BRICK), by = Math.ceil(g.dims[1] / BRICK);
    for (const b of boxes) {
      const sx = b.max[0] - b.min[0] + 1, sy = b.max[1] - b.min[1] + 1, sz = b.max[2] - b.min[2] + 1;
      const sub = new Uint8Array(sx * sy * sz);
      for (let z = 0; z < sz; z++)
        for (let y = 0; y < sy; y++) {
          const src = b.min[0] + dx * (b.min[1] + y + dy * (b.min[2] + z));
          sub.set(g.cells.subarray(src, src + sx), sx * (y + sy * z));
        }
      d.queue.writeTexture({ texture: this.voxelTex, origin: b.min }, sub, { bytesPerRow: sx, rowsPerImage: sy }, [sx, sy, sz]);

      // Recompute the bricks this box touches.
      const lo = b.min.map((v) => v >> 3), hi = b.max.map((v) => v >> 3);
      const bsx = hi[0] - lo[0] + 1, bsy = hi[1] - lo[1] + 1, bsz = hi[2] - lo[2] + 1;
      const bsub = new Uint8Array(bsx * bsy * bsz);
      for (let k = lo[2]; k <= hi[2]; k++)
        for (let j = lo[1]; j <= hi[1]; j++)
          for (let i = lo[0]; i <= hi[0]; i++) {
            let occ = 0;
            for (let z = k * BRICK; z < Math.min((k + 1) * BRICK, g.dims[2]) && !occ; z++)
              for (let y = j * BRICK; y < Math.min((j + 1) * BRICK, dy) && !occ; y++) {
                const row = dx * (y + dy * z);
                for (let x = i * BRICK; x < Math.min((i + 1) * BRICK, dx); x++) if (g.cells[row + x]) { occ = 1; break; }
              }
            this.bricks[i + bx * (j + by * k)] = occ;
            bsub[(i - lo[0]) + bsx * ((j - lo[1]) + bsy * (k - lo[2]))] = occ;
          }
      d.queue.writeTexture({ texture: this.brickTex, origin: lo as [number, number, number] }, bsub, { bytesPerRow: bsx, rowsPerImage: bsy }, [bsx, bsy, bsz]);
    }
    this.reset();
  }

  /** Equirectangular HDR environment (RGBA half floats + sampling table), or null to clear it. */
  setEnvironment(env: { width: number; height: number; data: Uint16Array; sampling?: { width: number; height: number; table: Float32Array } } | null) {
    this.envTex.destroy();
    this.envTable.destroy();
    this.envTex = env ? this.makeEnvTexture(env.width, env.height, env.data) : this.makeEnvTexture(1, 1, new Uint16Array(4));
    this.envTable = this.makeEnvTable(env?.sampling?.table ?? new Float32Array(4));
    this.envSampleSize = env?.sampling ? [env.sampling.width, env.sampling.height] : [0, 0];
    this.hasEnvironment = !!env;
    this.rebind();
    this.reset();
  }

  private makeEnvTexture(w: number, h: number, data: Uint16Array) {
    const max = this.device.limits.maxTextureDimension2D;
    if (w > max || h > max) throw new Error(`HDR image is ${w}×${h}; this GPU allows ${max} per side.`);
    const t = this.device.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.device.queue.writeTexture({ texture: t }, data as Uint16Array<ArrayBuffer>, { bytesPerRow: w * 8 }, [w, h]);
    return t;
  }

  private makeEnvTable(table: Float32Array) {
    const b = this.device.createBuffer({ size: Math.max(16, table.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(b, 0, table as Float32Array<ArrayBuffer>);
    return b;
  }

  resize(width: number, height: number) {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (width === this.width && height === this.height && this.accum) return;
    this.width = width;
    this.height = height;
    this.accum?.destroy();
    this.accum = this.device.createBuffer({ size: width * height * 16, usage: GPUBufferUsage.STORAGE });
    this.bloomA?.destroy();
    this.bloomB?.destroy();
    const bw = Math.max(1, Math.ceil(width / 4)), bh = Math.max(1, Math.ceil(height / 4));
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    this.bloomA = this.device.createTexture({ size: [bw, bh], format: 'rgba16float', usage });
    this.bloomB = this.device.createTexture({ size: [bw, bh], format: 'rgba16float', usage });
    this.rebind();
    this.reset();
  }

  setFrame(frame: FrameParams) {
    this.frame = frame;
    this.reset();
  }

  reset() {
    this.samples = 0;
  }

  get ready() {
    return !!(this.traceGroup && this.presentGroup && this.frame && this.grid);
  }

  private rebind() {
    if (!this.voxelTex || !this.brickTex || !this.accum || !this.bloomA || !this.bloomB) return;
    const d = this.device;
    this.traceGroup = d.createBindGroup({
      layout: this.tracePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: this.voxelTex.createView() },
        { binding: 2, resource: this.brickTex.createView() },
        { binding: 3, resource: { buffer: this.materials } },
        { binding: 4, resource: { buffer: this.accum } },
        { binding: 5, resource: this.envTex.createView() },
        { binding: 6, resource: { buffer: this.envTable } },
      ],
    });
    this.presentGroup = d.createBindGroup({
      layout: this.presentPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.post } },
        { binding: 1, resource: { buffer: this.accum } },
        { binding: 2, resource: this.bloomA.createView() },
        { binding: 3, resource: this.sampler },
      ],
    });
    this.bloomGroups = [
      d.createBindGroup({
        layout: this.bloomPrep.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.bloomUniforms[0] } },
          { binding: 1, resource: { buffer: this.accum } },
          { binding: 2, resource: this.bloomA.createView() },
        ],
      }),
      d.createBindGroup({
        layout: this.bloomBlur.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.bloomUniforms[1] } },
          { binding: 2, resource: this.bloomB.createView() },
          { binding: 3, resource: this.bloomA.createView() },
        ],
      }),
      d.createBindGroup({
        layout: this.bloomBlur.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.bloomUniforms[2] } },
          { binding: 2, resource: this.bloomA.createView() },
          { binding: 3, resource: this.bloomB.createView() },
        ],
      }),
    ];
  }

  private writeParams(target: GPUBuffer) {
    const f = this.frame!, g = this.grid!, c = f.camera, l = f.lighting;
    const buf = new ArrayBuffer(PARAMS_BYTES);
    const fv = new Float32Array(buf);
    const uv = new Uint32Array(buf);
    const put = (slot: number, v: Vec3, w: number) => fv.set([v[0], v[1], v[2], w], slot * 4);
    put(0, c.position, c.orthographic ? 0 : c.aperture);
    put(1, c.forward, c.focusDistance);
    put(2, c.right, c.scale);
    put(3, c.up, c.orthographic ? 1 : 0);
    put(4, l.sunDirection, l.sunCosRadius);
    put(5, l.sunColor, l.sunEnabled ? 1 : 0);
    put(6, l.skyColor, 0);
    put(7, l.background ?? [0, 0, 0], l.background ? 1 : 0);
    put(8, l.ground ?? [0, 0, 0], l.ground ? 1 : 0);
    put(9, g.origin, l.groundHeight);
    uv.set([g.dims[0], g.dims[1], g.dims[2], this.samples], 40);
    uv.set([this.width, this.height, f.maxBounces, this.seed], 44);
    put(12, l.rayleigh, l.mieDensity);
    put(13, l.mieColor, l.mieG);
    // HDR mode without an image loaded falls back to the atmosphere.
    const mode = l.skyMode === 'hdr' ? (this.hasEnvironment ? 2 : 1) : l.skyMode === 'atmosphere' ? 1 : 0;
    fv.set([mode, l.hdrIntensity, l.hdrRotation, l.atmosphereIntensity], 56);
    fv.set([Math.hypot(g.dims[0], g.dims[1]) / 2, l.horizonFade, l.sunDisk ? 1 : 0, l.fogG], 60);
    uv.set([this.envSampleSize[0], this.envSampleSize[1], this.envSampleSize[0] > 0 ? 1 : 0, 0], 64);
    put(17, l.fogColor, l.fogDensity);
    this.device.queue.writeBuffer(target, 0, buf);
  }

  /** Trace `count` more samples per pixel. Encodes into the given encoder. */
  trace(encoder: GPUCommandEncoder, count = 1) {
    if (!this.ready) return;
    for (let i = 0; i < count; i++) {
      // writeBuffer lands at submit time, before the encoder runs, so several samples in one
      // submit would all see the last value. Each sample copies from its own staging buffer.
      const idx = this.samples % 64;
      if (!this.staging[idx]) this.staging[idx] = this.device.createBuffer({ size: PARAMS_BYTES, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      this.writeParams(this.staging[idx]);
      encoder.copyBufferToBuffer(this.staging[idx], 0, this.params, 0, PARAMS_BYTES);
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.tracePipeline);
      pass.setBindGroup(0, this.traceGroup!);
      pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
      pass.end();
      this.samples++;
    }
  }

  private encodeBloom(encoder: GPUCommandEncoder, post: PostParams) {
    const bw = this.bloomA!.width, bh = this.bloomA!.height;
    const r = post.bloomScale * bh * 0.25;
    const rx = r * 2 * post.bloomAspect, ry = r * 2 * (1 - post.bloomAspect);
    const write = (i: number, radius: number, dir: [number, number]) => {
      const buf = new ArrayBuffer(48);
      const u = new Uint32Array(buf), f = new Float32Array(buf);
      u.set([this.width, this.height, bw, bh], 0);
      f.set([Math.max(1, this.samples), post.exposure, post.bloomThreshold, radius, dir[0], dir[1]], 4);
      this.device.queue.writeBuffer(this.bloomUniforms[i], 0, buf);
    };
    write(0, 0, [0, 0]);
    write(1, rx, [1, 0]);
    write(2, ry, [0, 1]);
    const pass = encoder.beginComputePass();
    const wg: [number, number] = [Math.ceil(bw / 8), Math.ceil(bh / 8)];
    pass.setPipeline(this.bloomPrep);
    pass.setBindGroup(0, this.bloomGroups[0]);
    pass.dispatchWorkgroups(...wg);
    pass.setPipeline(this.bloomBlur);
    pass.setBindGroup(0, this.bloomGroups[1]); // A → B horizontally
    pass.dispatchWorkgroups(...wg);
    pass.setBindGroup(0, this.bloomGroups[2]); // B → A vertically
    pass.dispatchWorkgroups(...wg);
    pass.end();
  }

  /** Draw the current average into a texture view (canvas or offscreen). */
  present(encoder: GPUCommandEncoder, target: GPUTextureView, post: PostParams) {
    if (!this.ready) return;
    if (post.bloomMix > 0) this.encodeBloom(encoder, post);
    const buf = new ArrayBuffer(32);
    const fv = new Float32Array(buf), uv = new Uint32Array(buf);
    uv.set([this.width, this.height], 0);
    fv.set([Math.max(1, this.samples), post.exposure], 2);
    uv[4] = { none: 0, aces: 1, reinhard: 2 }[post.tonemap];
    fv.set([post.gamma, post.vignette, post.bloomMix], 5);
    this.device.queue.writeBuffer(this.post, 0, buf);
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(this.presentPipeline);
    pass.setBindGroup(0, this.presentGroup!);
    pass.draw(3);
    pass.end();
  }

  get outputFormat() {
    return this.format;
  }
}
