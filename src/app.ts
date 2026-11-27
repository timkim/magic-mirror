// Magic Mirror app state: settings, features, the Magic Prism renderer and the render loop.
// No DOM layout here: the Svelte components (src/ui) read this through stores and events.

import { writable, type Readable } from 'svelte/store';
import type { Feature, UiContribution, UiSlot } from './core/feature';
import type { Settings } from './core/settings';
import { createSettings } from './features';
import { Renderer } from './render/renderer';
import { frameFromSettings, outputSize, postFromSettings } from './render/params';
import { readPixels } from './render/readback';
import { loadHdrEnvironment } from './render/hdr';
import { parseVox } from './vox/parser';
import { SceneBaker, animationLength, type VoxelGrid } from './vox/scene';
import { applyCameraKeys, getKeys, keysToVox, lastKeyFrame } from './anim/camera';
import type { VoxFile } from './vox/types';
import { serializeVox } from './vox/serialize';
import { emptyScene } from './vox/empty';
import { History } from './edit/history';
import { VoxelEditor } from './edit/editor';

type Events = {
  sceneLoaded: (file: VoxFile, grid: VoxelGrid, name: string) => void;
  environmentLoaded: (name: string) => void;
  /** Every animation frame, after rendering. */
  frame: (dt: number) => void;
};

export interface FileHandler {
  /** Return true if this handler takes the dropped/opened file. */
  accepts(file: File): boolean;
  open(file: File): void | Promise<void>;
}

/** Something that takes pointer input on the render before orbiting (e.g. the voxel editor). */
export interface ViewportTool {
  /** u, v in 0..1 from the image's top-left; aspect = width / height. Return true to take the drag. */
  pointerDown(u: number, v: number, aspect: number, e: PointerEvent): boolean;
  pointerMove(u: number, v: number, aspect: number, e: PointerEvent): void;
  pointerUp(e: PointerEvent): void;
  leave?(): void;
  /** While active, left-drag goes to the tool and right-drag orbits. */
  active(): boolean;
}

export interface SceneInfo {
  file: VoxFile;
  grid: VoxelGrid;
  name: string;
}

export class App {
  readonly settings: Settings;
  readonly renderer: Renderer;
  file: VoxFile | null = null;
  fileName = '';
  /** The original bytes of the open .vox (sent to render farm workers). */
  fileBytes: Uint8Array | null = null;
  /** The loaded HDR sky image, if any. */
  environment: { name: string; bytes: Uint8Array } | null = null;
  grid: VoxelGrid | null = null;
  /** Undo/redo for every scene change. */
  readonly history = new History();
  /** The voxel editor (also the API scripts and the assistant use to change the scene). */
  readonly editor: VoxelEditor;
  readonly viewportTools: ViewportTool[] = [];
  /** Things dropped on the render other than files (e.g. library assets). u, v in 0..1. */
  readonly stageDrops: ((e: DragEvent, u: number, v: number, aspect: number) => boolean)[] = [];
  /** CSS cursor for the render view while a tool is active (null = orbit cursor). */
  readonly viewportCursor = writable<string | null>(null);

  /** Status bar fields, keyed by id. */
  readonly status = writable<Record<string, string>>({});
  /** The open scene (null until one is loaded). */
  readonly scene = writable<SceneInfo | null>(null);
  /** Render output size in pixels. */
  readonly outputSize = writable<[number, number]>([1, 1]);

  private baker: SceneBaker | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: GPUCanvasContext | null = null;
  private viewportPx: [number, number] = [1280, 720];
  private frameDirty = true;
  private listeners: { [K in keyof Events]: Events[K][] } = { sceneLoaded: [], environmentLoaded: [], frame: [] };
  private fileHandlers: FileHandler[] = [];
  private lastTime = performance.now();
  private inFlight = 0;
  private sampleTimer = { samples: 0, since: performance.now(), rate: 0 };

  private constructor(private device: GPUDevice, readonly features: Feature[]) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const app = this;
    this.settings = createSettings(features);
    this.renderer = new Renderer(device, navigator.gpu.getPreferredCanvasFormat());
    this.editor = new VoxelEditor(
      {
        get file() { return app.file; },
        get grid() { return app.grid; },
        placements: () => this.baker?.placements ?? [],
        cameraFrame: () => (this.grid ? frameFromSettings(this.settings, this.grid).camera : null),
        modelsChanged: (ids) => this.modelsChanged(ids),
        materialsChanged: () => this.file && this.renderer.setMaterials(this.file.palette, this.file.materials),
        structureChanged: () => this.rebake(),
        setStatus: (id, text) => this.setStatus(id, text),
      },
      this.history,
    );
    this.settings.onChange((key) => {
      const def = this.settings.def(key);
      if (key === 'anim.frame') {
        this.rebuildGrid();
        applyCameraKeys(this.settings);
      } else if (key === 'cam.keys') applyCameraKeys(this.settings);
      else if (def && def.resetsRender !== false) this.frameDirty = true;
    });
    this.registerFileHandler({
      accepts: (f) => f.name.toLowerCase().endsWith('.vox'),
      open: async (f) => this.openVox(new Uint8Array(await f.arrayBuffer()), f.name),
    });
  }

  static async create(features: Feature[]): Promise<App> {
    if (!navigator.gpu) throw new Error('This browser has no WebGPU. Use a recent Chrome or Edge.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const device = await adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize },
    });
    device.lost.then((info) => console.error('WebGPU device lost:', info.message));
    const app = new App(device, features);
    for (const f of features) f.init?.(app);
    requestAnimationFrame(() => app.loop());
    return app;
  }

  /** UI contributions from every feature for one slot, in order. */
  ui(slot: UiSlot): UiContribution[] {
    return this.features.flatMap((f) => f.ui ?? []).filter((u) => u.slot === slot).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  /** Called by the viewport component with its canvas. */
  attachCanvas(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.context = canvas.getContext('webgpu');
    this.context?.configure({ device: this.device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
  }

  /** Called by the viewport component when its size changes (CSS pixels). */
  setViewportSize(width: number, height: number) {
    const dpr = window.devicePixelRatio || 1;
    this.viewportPx = [Math.max(1, width * dpr), Math.max(1, height * dpr)];
  }

  on<K extends keyof Events>(event: K, cb: Events[K]): () => void {
    this.listeners[event].push(cb);
    return () => {
      this.listeners[event] = this.listeners[event].filter((x) => x !== cb) as never;
    };
  }

  setStatus(id: string, text: string) {
    this.status.update((s) => ({ ...s, [id]: text }));
  }

  registerFileHandler(h: FileHandler) {
    this.fileHandlers.push(h);
  }

  async openFile(f: File) {
    const h = this.fileHandlers.find((x) => x.accepts(f));
    if (!h) return this.setStatus('msg', `Can't open ${f.name}`);
    try {
      await h.open(f);
    } catch (e) {
      this.setStatus('msg', `Error: ${(e as Error).message}`);
      console.error(e);
    }
  }

  openVox(bytes: Uint8Array, name: string) {
    this.loadScene(parseVox(bytes), name, bytes);
  }

  /** Start an empty scene with one blank model to build in (or, with null, no models at all). */
  newScene(size: [number, number, number] | null = [40, 40, 40]) {
    const file = emptyScene();
    if (!size) {
      this.loadScene(file, 'untitled.vox', null);
      return;
    }
    file.models.push({ size, voxels: new Uint8Array(0) });
    file.nodes.set(2, { kind: 'transform', id: 2, attrs: { _name: 'model' }, childId: 3, layerId: 0, frames: [{ rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, Math.floor(size[2] / 2)] }] });
    file.nodes.set(3, { kind: 'shape', id: 3, attrs: {}, models: [{ modelId: 0 }] });
    (file.nodes.get(1) as { childIds: number[] }).childIds.push(2);
    this.loadScene(file, 'untitled.vox', null);
    this.editor.enabled.set(true);
    this.editor.selected.set(2); // the model's transform node
  }

  private loadScene(file: VoxFile, name: string, bytes: Uint8Array | null) {
    this.file = file;
    this.fileName = name;
    this.fileBytes = bytes;
    this.history.clear();
    this.editor.reset();
    this.baker = new SceneBaker(file, this.settings.num('anim.frame'));
    this.grid = this.baker.grid;
    for (const f of this.features) f.onSceneLoaded?.(file, this.grid, this.settings);
    this.renderer.setScene(this.grid, file.palette, file.materials);
    this.frameDirty = true;
    for (const cb of this.listeners.sceneLoaded) cb(file, this.grid, name);
    this.scene.set({ file, grid: this.grid, name });
    this.setStatus('msg', `${name}: ${this.grid.voxelCount.toLocaleString()} voxels`);
  }

  /** Last frame of the timeline: scene keyframes, camera keyframes or the chosen end. */
  animationEnd(): number {
    if (!this.file) return 0;
    return Math.max(animationLength(this.file), lastKeyFrame(getKeys(this.settings)), this.settings.num('anim.end'));
  }

  /** The scene as .vox bytes, including any edits (and camera keyframes). */
  voxBytes(): Uint8Array | null {
    if (!this.file) return null;
    if (!this.fileBytes || this.history.dirty) {
      keysToVox(this.file, this.settings.str('cam.keys'), this.settings.num('anim.end'));
      this.fileBytes = serializeVox(this.file);
    }
    this.history.dirty = false;
    return this.fileBytes;
  }

  /** Download the scene (with edits) as a .vox MagicaVoxel can open. */
  saveVox() {
    const bytes = this.voxBytes();
    if (!bytes) return;
    download(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), this.fileName || 'scene.vox');
    this.setStatus('msg', `Saved ${this.fileName}`);
  }

  private modelsChanged(ids: number[]) {
    const boxes = this.baker?.refreshModels(ids);
    if (boxes === null) return this.rebake();
    if (boxes) this.renderer.updateRegions(boxes);
    this.setStatus('voxels', `${this.grid?.voxelCount.toLocaleString()} voxels`);
  }

  /** Rebuild the grid after the scene graph or a model's size changed, keeping the view. */
  private rebake() {
    if (!this.file) return;
    this.baker = new SceneBaker(this.file, this.settings.num('anim.frame'));
    this.grid = this.baker.grid;
    this.renderer.setScene(this.grid, this.file.palette, this.file.materials);
    this.frameDirty = true;
    this.scene.set({ file: this.file, grid: this.grid, name: this.fileName });
    this.setStatus('voxels', `${this.grid.voxelCount.toLocaleString()} voxels`);
  }

  private rebuildGrid() {
    if (!this.baker) return;
    this.renderer.updateRegions(this.baker.setTime(this.settings.num('anim.frame')));
    this.frameDirty = true;
  }

  /** Light the scene with an equirectangular .hdr image. */
  loadEnvironment(bytes: Uint8Array, name: string) {
    this.renderer.setEnvironment(loadHdrEnvironment(bytes));
    this.environment = { name, bytes };
    this.settings.set('sky.mode', 'hdr');
    this.frameDirty = true;
    for (const cb of this.listeners.environmentLoaded) cb(name);
  }

  /** Restart progressive rendering (e.g. after something outside the settings changed). */
  restart() {
    this.frameDirty = true;
  }

  renderSize(): [number, number] {
    return outputSize(this.settings, this.viewportPx);
  }

  /** The current render as a PNG at full output size. */
  async renderPng(): Promise<Blob> {
    const px = await readPixels(this.renderer, postFromSettings(this.settings));
    const c = document.createElement('canvas');
    c.width = px.width;
    c.height = px.height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.data), px.width, px.height), 0, 0);
    return new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
  }

  async savePng() {
    if (!this.renderer.ready) return;
    const blob = await this.renderPng();
    const base = this.fileName.replace(/\.vox$/i, '') || 'render';
    download(blob, `${base}_f${this.settings.num('anim.frame')}_${this.renderer.samples}spp.png`);
  }

  private loop() {
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    for (const f of this.features) f.onFrame?.(this, dt);

    const [w, h] = this.renderSize();
    if (this.renderer.width !== w || this.renderer.height !== h) {
      this.renderer.resize(w, h);
      this.outputSize.set([w, h]);
      this.frameDirty = true;
    }
    if (this.canvas && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.grid && this.frameDirty) {
      this.renderer.setFrame(frameFromSettings(this.settings, this.grid));
      this.frameDirty = false;
    }

    let n = 0;
    // Keep at most two frames queued on the GPU. Without this a slow GPU builds an endless
    // backlog and readbacks (Save PNG, farm frames) wait behind it.
    if (this.renderer.ready && this.inFlight < 2) {
      const enc = this.renderer.device.createCommandEncoder();
      const remaining = this.settings.num('rt.maxSamples') - this.renderer.samples;
      n = Math.max(0, Math.min(this.settings.num('rt.samplesPerFrame'), remaining));
      this.renderer.trace(enc, n);
      if (this.context) this.renderer.present(enc, this.context.getCurrentTexture().createView(), postFromSettings(this.settings));
      this.renderer.device.queue.submit([enc.finish()]);
      this.inFlight++;
      this.renderer.device.queue.onSubmittedWorkDone().then(() => this.inFlight--);
      this.sampleTimer.samples += n;
    }
    for (const cb of this.listeners.frame) cb(dt);
    if (now - this.sampleTimer.since > 500) {
      this.sampleTimer.rate = (this.sampleTimer.samples * 1000) / (now - this.sampleTimer.since);
      this.sampleTimer = { samples: 0, since: now, rate: this.sampleTimer.rate };
      this.status.update((s) => ({
        ...s,
        samples: `${this.renderer.samples} / ${this.settings.num('rt.maxSamples')} samples`,
        rate: `${this.sampleTimer.rate.toFixed(1)} samples/s`,
        size: `${w} × ${h}`,
      }));
    }
    requestAnimationFrame(() => this.loop());
  }
}

/** Save a blob as a download. */
export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.download = name;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export type { Readable };
