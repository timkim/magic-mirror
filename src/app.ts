// Browser app: wires settings, features, the renderer and the UI shell together.

import type { Feature } from './core/feature';
import type { Settings } from './core/settings';
import { createSettings } from './features';
import { Layout } from './ui/layout';
import { buildSettingsPanels } from './ui/settingsPanel';
import { Renderer } from './render/renderer';
import { frameFromSettings, outputSize, postFromSettings } from './render/params';
import { readPixels } from './render/readback';
import { parseVox } from './vox/parser';
import { buildVoxelGrid, type VoxelGrid } from './vox/scene';
import type { VoxFile } from './vox/types';

type Events = { sceneLoaded: (file: VoxFile, grid: VoxelGrid, name: string) => void };

export interface FileHandler {
  /** Return true if this handler takes the dropped/opened file. */
  accepts(file: File): boolean;
  open(file: File): void | Promise<void>;
}

export class App {
  readonly settings: Settings;
  readonly layout: Layout;
  readonly renderer: Renderer;
  readonly canvas: HTMLCanvasElement;
  file: VoxFile | null = null;
  fileName = '';
  grid: VoxelGrid | null = null;
  private context: GPUCanvasContext;
  private frameDirty = true;
  private listeners: { [K in keyof Events]: Events[K][] } = { sceneLoaded: [] };
  private fileHandlers: FileHandler[] = [];
  private lastTime = performance.now();
  private sampleTimer = { samples: 0, since: performance.now(), rate: 0 };

  private constructor(root: HTMLElement, device: GPUDevice, readonly features: Feature[]) {
    this.settings = createSettings(features);
    this.layout = new Layout(root);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mm-canvas';
    this.layout.stage.append(this.canvas);
    const format = navigator.gpu.getPreferredCanvasFormat();
    this.context = this.canvas.getContext('webgpu')!;
    this.context.configure({ device, format, alphaMode: 'opaque' });
    this.renderer = new Renderer(device, format);

    this.settings.onChange((key) => {
      const def = this.settings.def(key);
      if (key === 'anim.frame') this.rebuildGrid();
      else if (def && def.resetsRender !== false) this.frameDirty = true;
    });

    this.registerFileHandler({
      accepts: (f) => f.name.toLowerCase().endsWith('.vox'),
      open: async (f) => this.openVox(new Uint8Array(await f.arrayBuffer()), f.name),
    });
    this.setupDrop();
    window.addEventListener('resize', () => this.fitStage());
  }

  static async create(root: HTMLElement, features: Feature[]): Promise<App> {
    if (!navigator.gpu) throw new Error('This browser has no WebGPU. Use a recent Chrome or Edge.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const device = await adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize },
    });
    device.lost.then((info) => console.error('WebGPU device lost:', info.message));
    const app = new App(root, device, features);
    for (const f of features) f.init?.(app);
    buildSettingsPanels(app.settings, app.layout);
    app.fitStage();
    requestAnimationFrame(() => app.loop());
    return app;
  }

  on<K extends keyof Events>(event: K, cb: Events[K]) {
    this.listeners[event].push(cb);
  }

  registerFileHandler(h: FileHandler) {
    this.fileHandlers.push(h);
  }

  async openFile(f: File) {
    const h = this.fileHandlers.find((x) => x.accepts(f));
    if (!h) return this.layout.setStatus('msg', `Can't open ${f.name}`);
    try {
      await h.open(f);
    } catch (e) {
      this.layout.setStatus('msg', `Error: ${(e as Error).message}`);
      console.error(e);
    }
  }

  openVox(bytes: Uint8Array, name: string) {
    const file = parseVox(bytes);
    this.file = file;
    this.fileName = name;
    this.grid = buildVoxelGrid(file, this.settings.num('anim.frame'));
    for (const f of this.features) f.onSceneLoaded?.(file, this.grid, this.settings);
    this.renderer.setScene(this.grid, file.palette, file.materials);
    this.frameDirty = true;
    for (const cb of this.listeners.sceneLoaded) cb(file, this.grid, name);
    this.layout.setStatus('msg', `${name}: ${this.grid.voxelCount.toLocaleString()} voxels`);
    document.body.classList.add('has-scene');
  }

  private rebuildGrid() {
    if (!this.file) return;
    this.grid = buildVoxelGrid(this.file, this.settings.num('anim.frame'));
    this.renderer.setScene(this.grid, this.file.palette, this.file.materials);
    this.frameDirty = true;
  }

  /** Restart progressive rendering (e.g. after something outside the settings changed). */
  restart() {
    this.frameDirty = true;
  }

  renderSize(): [number, number] {
    const dpr = window.devicePixelRatio || 1;
    return outputSize(this.settings, [this.layout.viewport.clientWidth * dpr, this.layout.viewport.clientHeight * dpr]);
  }

  private fitStage() {
    const [w, h] = this.renderSize();
    this.layout.fitStage(w, h);
  }

  async savePng() {
    if (!this.renderer.ready) return;
    const px = await readPixels(this.renderer, postFromSettings(this.settings));
    const c = document.createElement('canvas');
    c.width = px.width; c.height = px.height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.data), px.width, px.height), 0, 0);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
    const a = document.createElement('a');
    const base = this.fileName.replace(/\.vox$/i, '') || 'render';
    a.download = `${base}_f${this.settings.num('anim.frame')}_${this.renderer.samples}spp.png`;
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private setupDrop() {
    window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('dragging');
      for (const f of Array.from(e.dataTransfer?.files ?? [])) this.openFile(f);
    });
  }

  private loop() {
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    for (const f of this.features) f.onFrame?.(this, dt);

    const [w, h] = this.renderSize();
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.renderer.resize(w, h);
      this.fitStage();
      this.frameDirty = true;
    }
    if (this.grid && this.frameDirty) {
      this.renderer.setFrame(frameFromSettings(this.settings, this.grid));
      this.frameDirty = false;
    }

    if (this.renderer.ready) {
      const enc = this.renderer.device.createCommandEncoder();
      const remaining = this.settings.num('rt.maxSamples') - this.renderer.samples;
      const n = Math.max(0, Math.min(this.settings.num('rt.samplesPerFrame'), remaining));
      this.renderer.trace(enc, n);
      this.renderer.present(enc, this.context.getCurrentTexture().createView(), postFromSettings(this.settings));
      this.renderer.device.queue.submit([enc.finish()]);
      this.sampleTimer.samples += n;
    }
    if (now - this.sampleTimer.since > 500) {
      this.sampleTimer.rate = (this.sampleTimer.samples * 1000) / (now - this.sampleTimer.since);
      this.sampleTimer = { samples: 0, since: now, rate: this.sampleTimer.rate };
      this.layout.setStatus('samples', `${this.renderer.samples} / ${this.settings.num('rt.maxSamples')} samples`);
      this.layout.setStatus('rate', `${this.sampleTimer.rate.toFixed(1)} samples/s`);
      this.layout.setStatus('size', `${w} × ${h}`);
    }
    requestAnimationFrame(() => this.loop());
  }
}
