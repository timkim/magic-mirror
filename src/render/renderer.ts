// GPU side of Magic Mirror. Independent of the DOM: it takes a GPUDevice and renders into
// any texture view, so the same code runs in the browser and in headless render workers.

import { PATHTRACE_WGSL } from './shaders/pathtrace.wgsl';
import { PRESENT_WGSL } from './shaders/present.wgsl';
import { buildMaterialTable } from './materials';
import type { VoxelGrid } from '../vox/scene';
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

export interface LightingParams {
  sunDirection: Vec3; // towards the sun
  sunCosRadius: number;
  sunColor: Vec3; // already multiplied by intensity
  sunEnabled: boolean;
  skyColor: Vec3;
  background: Vec3 | null; // null = show the sky behind the scene
  ground: Vec3 | null; // null = no ground plane
  groundHeight: number;
}

export interface PostParams {
  exposure: number; // linear multiplier
  tonemap: 'none' | 'aces' | 'reinhard';
  gamma: number;
  vignette: number;
}

export interface FrameParams {
  camera: CameraParams;
  lighting: LightingParams;
  maxBounces: number;
}

const BRICK = 8;

export class Renderer {
  readonly device: GPUDevice;
  private format: GPUTextureFormat;
  private traceModule: GPUComputePipeline;
  private presentPipeline: GPURenderPipeline;
  private params: GPUBuffer;
  private post: GPUBuffer;
  private materials: GPUBuffer;
  private voxelTex: GPUTexture | null = null;
  private brickTex: GPUTexture | null = null;
  private accum: GPUBuffer | null = null;
  private traceGroup: GPUBindGroup | null = null;
  private presentGroup: GPUBindGroup | null = null;
  private grid: VoxelGrid | null = null;
  private frame: FrameParams | null = null;
  width = 0;
  height = 0;
  /** Samples accumulated per pixel since the last reset. */
  samples = 0;
  private seed = 1;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
    const traceShader = device.createShaderModule({ label: 'pathtrace', code: PATHTRACE_WGSL });
    this.traceModule = device.createComputePipeline({ label: 'pathtrace', layout: 'auto', compute: { module: traceShader, entryPoint: 'main' } });
    const presentShader = device.createShaderModule({ label: 'present', code: PRESENT_WGSL });
    this.presentPipeline = device.createRenderPipeline({
      label: 'present',
      layout: 'auto',
      vertex: { module: presentShader, entryPoint: 'vs' },
      fragment: { module: presentShader, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.params = device.createBuffer({ size: 12 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.post = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.materials = device.createBuffer({ size: 256 * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  /** Check shaders compiled; returns error messages (empty when fine). */
  static async shaderErrors(device: GPUDevice): Promise<string[]> {
    const errs: string[] = [];
    for (const [label, code] of [['pathtrace', PATHTRACE_WGSL], ['present', PRESENT_WGSL]]) {
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
    this.brickTex = d.createTexture({ size: [bx, by, bz], dimension: '3d', format: 'r8uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: this.brickTex }, bricks, { bytesPerRow: bx, rowsPerImage: by }, [bx, by, bz]);

    d.queue.writeBuffer(this.materials, 0, buildMaterialTable(palette, materials) as Float32Array<ArrayBuffer>);
    this.rebind();
    this.reset();
  }

  resize(width: number, height: number) {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (width === this.width && height === this.height && this.accum) return;
    this.width = width;
    this.height = height;
    this.accum?.destroy();
    this.accum = this.device.createBuffer({ size: width * height * 16, usage: GPUBufferUsage.STORAGE });
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
    if (!this.voxelTex || !this.brickTex || !this.accum) return;
    const d = this.device;
    this.traceGroup = d.createBindGroup({
      layout: this.traceModule.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: this.voxelTex.createView() },
        { binding: 2, resource: this.brickTex.createView() },
        { binding: 3, resource: { buffer: this.materials } },
        { binding: 4, resource: { buffer: this.accum } },
      ],
    });
    this.presentGroup = d.createBindGroup({
      layout: this.presentPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.post } },
        { binding: 1, resource: { buffer: this.accum } },
      ],
    });
  }

  private writeParams(target: GPUBuffer) {
    const f = this.frame!, g = this.grid!, c = f.camera, l = f.lighting;
    const buf = new ArrayBuffer(12 * 16);
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
    this.device.queue.writeBuffer(target, 0, buf);
  }

  /** Trace `count` more samples per pixel. Encodes into the given encoder. */
  trace(encoder: GPUCommandEncoder, count = 1) {
    if (!this.ready) return;
    for (let i = 0; i < count; i++) {
      this.writeParamsInto(encoder);
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.traceModule);
      pass.setBindGroup(0, this.traceGroup!);
      pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
      pass.end();
      this.samples++;
    }
  }

  private staging: GPUBuffer[] = [];
  private writeParamsInto(encoder: GPUCommandEncoder) {
    // writeBuffer is applied at submit time, before the encoder runs, so multiple samples in one
    // submit would all see the last value. Copy from a per-sample staging buffer instead.
    const d = this.device;
    const idx = this.samples % 64;
    if (!this.staging[idx]) this.staging[idx] = d.createBuffer({ size: 12 * 16, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.writeParams(this.staging[idx]);
    encoder.copyBufferToBuffer(this.staging[idx], 0, this.params, 0, 12 * 16);
  }

  /** Draw the current average into a texture view (canvas or offscreen). */
  present(encoder: GPUCommandEncoder, target: GPUTextureView, post: PostParams) {
    if (!this.ready) return;
    const buf = new ArrayBuffer(32);
    const fv = new Float32Array(buf), uv = new Uint32Array(buf);
    uv.set([this.width, this.height], 0);
    fv.set([Math.max(1, this.samples), post.exposure], 2);
    uv[4] = { none: 0, aces: 1, reinhard: 2 }[post.tonemap];
    fv.set([post.gamma, post.vignette, 0], 5);
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
