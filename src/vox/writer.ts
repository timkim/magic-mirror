// Minimal .vox writer, used for generated test scenes and parser round-trip tests.
// Layout follows what MagicaVoxel 0.99.7 accepts: version 200, models first, then the
// scene graph in depth-first order with ids 0..n-1, then palette, materials, render settings.

import type { VoxDict } from './types';

export interface WriterObject {
  name?: string;
  size: [number, number, number];
  voxels: [number, number, number, number][]; // x, y, z, colour index
  translation?: [number, number, number];
  rotation?: number; // _r byte
}

export interface WriterScene {
  objects: WriterObject[];
  /** palette[i] = [r,g,b,a] for colour index i (1-255). Missing entries are grey. */
  palette?: Record<number, [number, number, number, number?]>;
  materials?: Record<number, VoxDict>;
  renderObjects?: VoxDict[];
  cameras?: { id: number; attrs: VoxDict }[];
}

class Out {
  private parts: number[] = [];
  int32(v: number) {
    this.parts.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  }
  id(s: string) {
    for (let i = 0; i < 4; i++) this.parts.push(s.charCodeAt(i));
  }
  bytes(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]);
  }
  string(s: string) {
    const b = new TextEncoder().encode(s);
    this.int32(b.length);
    this.bytes(b);
  }
  dict(d: VoxDict) {
    const keys = Object.keys(d);
    this.int32(keys.length);
    for (const k of keys) {
      this.string(k);
      this.string(d[k]);
    }
  }
  get data() {
    return new Uint8Array(this.parts);
  }
}

function chunk(id: string, fill: (o: Out) => void): Uint8Array {
  const content = new Out();
  fill(content);
  const c = content.data;
  const o = new Out();
  o.id(id);
  o.int32(c.length);
  o.int32(0);
  o.bytes(c);
  return o.data;
}

export function writeVox(scene: WriterScene): Uint8Array {
  const children: Uint8Array[] = [];
  for (const obj of scene.objects) {
    children.push(chunk('SIZE', (o) => obj.size.forEach((v) => o.int32(v))));
    children.push(
      chunk('XYZI', (o) => {
        o.int32(obj.voxels.length);
        for (const v of obj.voxels) o.bytes(v);
      }),
    );
  }
  // Scene graph: 0 root transform -> 1 group -> (transform -> shape) per object.
  children.push(chunk('nTRN', (o) => { o.int32(0); o.dict({}); o.int32(1); o.int32(-1); o.int32(-1); o.int32(1); o.dict({}); }));
  children.push(chunk('nGRP', (o) => { o.int32(1); o.dict({}); o.int32(scene.objects.length); scene.objects.forEach((_, i) => o.int32(2 + i * 2)); }));
  scene.objects.forEach((obj, i) => {
    const tid = 2 + i * 2;
    const frame: VoxDict = {};
    if (obj.translation) frame._t = obj.translation.join(' ');
    if (obj.rotation !== undefined) frame._r = String(obj.rotation);
    children.push(chunk('nTRN', (o) => { o.int32(tid); o.dict(obj.name ? { _name: obj.name } : {}); o.int32(tid + 1); o.int32(-1); o.int32(0); o.int32(1); o.dict(frame); }));
    children.push(chunk('nSHP', (o) => { o.int32(tid + 1); o.dict({}); o.int32(1); o.int32(i); o.dict({}); }));
  });
  children.push(chunk('LAYR', (o) => { o.int32(0); o.dict({}); o.int32(-1); }));
  children.push(
    chunk('RGBA', (o) => {
      for (let k = 1; k <= 256; k++) {
        const c = scene.palette?.[k] ?? [128, 128, 128, 255];
        o.bytes([c[0], c[1], c[2], c[3] ?? 255]);
      }
    }),
  );
  for (const [id, d] of Object.entries(scene.materials ?? {})) children.push(chunk('MATL', (o) => { o.int32(Number(id)); o.dict(d); }));
  for (const d of scene.renderObjects ?? []) children.push(chunk('rOBJ', (o) => o.dict(d)));
  for (const c of scene.cameras ?? []) children.push(chunk('rCAM', (o) => { o.int32(c.id); o.dict(c.attrs); }));

  const childLen = children.reduce((n, c) => n + c.length, 0);
  const o = new Out();
  o.id('VOX ');
  o.int32(200);
  o.id('MAIN');
  o.int32(0);
  o.int32(childLen);
  const head = o.data;
  const out = new Uint8Array(head.length + childLen);
  out.set(head, 0);
  let p = head.length;
  for (const c of children) { out.set(c, p); p += c.length; }
  return out;
}
