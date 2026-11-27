// Writes a VoxFile back to .vox bytes, keeping everything Magic Mirror doesn't edit.
// MagicaVoxel's rules (verified in 0.99.7): version 200, all SIZE/XYZI pairs first, then the
// scene graph depth-first from node 0 with ids 0..n-1 in chunk order, then the other chunks.
// An untouched file comes back byte for byte (see test/serialize.test.ts).

import { encodeRotation } from './parser';
import type { SceneNode, TransformFrame, VoxDict, VoxFile } from './types';

class Out {
  private buf = new Uint8Array(1 << 16);
  len = 0;
  private grow(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  int32(v: number) {
    this.grow(4);
    new DataView(this.buf.buffer).setInt32(this.len, v, true);
    this.len += 4;
  }
  id(s: string) {
    this.grow(4);
    for (let i = 0; i < 4; i++) this.buf[this.len++] = s.charCodeAt(i);
  }
  bytes(b: Uint8Array) {
    this.grow(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
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
  /** A chunk with no children; `fill` writes its content. */
  chunk(id: string, fill: (o: Out) => void) {
    this.id(id);
    const sizeAt = this.len;
    this.int32(0);
    this.int32(0);
    const start = this.len;
    fill(this);
    new DataView(this.buf.buffer).setInt32(sizeAt, this.len - start, true);
  }
  get data() {
    return this.buf.slice(0, this.len);
  }
}

const sameVec = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const vec = (s: string | undefined) => (s ? s.trim().split(/\s+/).map(Number) : [0, 0, 0]);

/** The DICT for one transform frame: the original one if nothing changed, else rebuilt. */
function frameDict(f: TransformFrame, animated: boolean): VoxDict {
  const a = f.attrs;
  const r = encodeRotation(f.rotation);
  if (a) {
    const sameT = sameVec(vec(a._t), f.translation);
    const sameR = (a._r !== undefined ? Number(a._r) : 4) === r || (a._r === undefined && r === encodeRotation([1, 0, 0, 0, 1, 0, 0, 0, 1]));
    const sameF = animated ? a._f !== undefined && Number(a._f) === f.frame : a._f === undefined;
    if (sameT && sameR && sameF) return a;
  }
  const d: VoxDict = { ...(a ?? {}) };
  if (d._r !== undefined || r !== 4) d._r = String(r);
  if (d._t !== undefined || f.translation.some((v) => v !== 0)) d._t = f.translation.join(' ');
  if (animated && f.frame !== undefined) d._f = String(f.frame);
  else delete d._f;
  return d;
}

/** Depth-first order from node 0, as MagicaVoxel requires. Unreachable nodes are dropped. */
function depthFirst(file: VoxFile): SceneNode[] {
  const order: SceneNode[] = [];
  const seen = new Set<number>();
  const visit = (id: number) => {
    const n = file.nodes.get(id);
    if (!n || seen.has(id)) return;
    seen.add(id);
    order.push(n);
    if (n.kind === 'transform') visit(n.childId);
    else if (n.kind === 'group') n.childIds.forEach(visit);
  };
  visit(0);
  return order;
}

export function serializeVox(file: VoxFile): Uint8Array {
  const body = new Out();
  for (const m of file.models) {
    body.chunk('SIZE', (o) => m.size.forEach((v) => o.int32(v)));
    body.chunk('XYZI', (o) => {
      o.int32(m.voxels.length / 4);
      o.bytes(m.voxels);
    });
  }

  const nodes = depthFirst(file);
  const newId = new Map(nodes.map((n, i) => [n.id, i]));
  for (const n of nodes) {
    const id = newId.get(n.id)!;
    if (n.kind === 'transform') {
      body.chunk('nTRN', (o) => {
        o.int32(id);
        o.dict(n.attrs);
        o.int32(newId.get(n.childId) ?? -1);
        o.int32(-1);
        o.int32(n.layerId);
        o.int32(n.frames.length);
        const animated = n.frames.length > 1 || n.frames[0]?.frame !== undefined;
        for (const f of n.frames) o.dict(frameDict(f, animated));
      });
    } else if (n.kind === 'group') {
      body.chunk('nGRP', (o) => {
        o.int32(id);
        o.dict(n.attrs);
        const kids = n.childIds.filter((c) => newId.has(c));
        o.int32(kids.length);
        for (const c of kids) o.int32(newId.get(c)!);
      });
    } else {
      body.chunk('nSHP', (o) => {
        o.int32(id);
        o.dict(n.attrs);
        o.int32(n.models.length);
        for (const m of n.models) {
          const d: VoxDict = { ...(m.attrs ?? {}) };
          if (m.frame !== undefined) d._f = String(m.frame);
          else delete d._f;
          o.int32(m.modelId);
          o.dict(m.attrs && (m.attrs._f === undefined ? m.frame === undefined : Number(m.attrs._f) === m.frame) ? m.attrs : d);
        }
      });
    }
  }

  // Trailing chunks: keep file order, regenerate the ones we edit (palette, materials).
  const rgba = () => {
    const raw = new Uint8Array(1024);
    raw.set(file.palette.subarray(4, 1024), 0);
    raw.set(file.paletteTail ?? [0, 0, 0, 255], 1020);
    return raw;
  };
  const writeMatl = (o: Out, id: number, d: VoxDict) => {
    o.int32(id);
    o.dict(d);
  };
  const trailing = file.trailing ?? defaultTrailing(file);
  const wroteMatl = new Set<number>();
  const wrote = new Set<string>();
  const writeObjects = () => {
    for (const d of file.renderObjects) body.chunk('rOBJ', (o) => o.dict(d));
  };
  const writeCameras = () => {
    for (const c of file.cameras)
      body.chunk('rCAM', (o) => {
        o.int32(c.id);
        o.dict(c.attrs);
      });
  };
  const writeLayer = (id: number, reserved: number) => {
    const l = file.layers.get(id)!;
    body.chunk('LAYR', (o) => {
      o.int32(id);
      o.dict(l.attrs);
      o.int32(reserved);
    });
  };
  const lastLayr = trailing.map((t) => t.id).lastIndexOf('LAYR');
  const wroteLayers = new Set<number>();
  for (const [i, t] of trailing.entries()) {
    if (t.id === 'LAYR') {
      // Regenerated from file.layers (names and visibility can be edited), dropped if deleted.
      const dv = new DataView(t.content.buffer, t.content.byteOffset, t.content.byteLength);
      const id = dv.getInt32(0, true);
      if (file.layers.has(id)) writeLayer(id, dv.getInt32(t.content.byteLength - 4, true));
      wroteLayers.add(id);
      if (i === lastLayr) for (const lid of file.layers.keys()) if (!wroteLayers.has(lid)) { writeLayer(lid, -1); wroteLayers.add(lid); }
      wrote.add(t.id);
      continue;
    }
    if (t.id === 'RGBA') {
      body.chunk('RGBA', (o) => o.bytes(rgba()));
    } else if (t.id === 'MATL') {
      const id = new DataView(t.content.buffer, t.content.byteOffset).getInt32(0, true);
      const d = file.materials.get(id);
      wroteMatl.add(id);
      if (d) body.chunk('MATL', (o) => writeMatl(o, id, d));
    } else if (t.id === 'rOBJ') {
      // Written from the parsed list (features may edit it) where the first one was.
      if (!wrote.has('rOBJ')) writeObjects();
    } else if (t.id === 'rCAM') {
      if (!wrote.has('rCAM')) writeCameras();
    } else {
      body.chunk(t.id, (o) => o.bytes(t.content));
    }
    wrote.add(t.id);
  }
  if (!wrote.has('RGBA')) body.chunk('RGBA', (o) => o.bytes(rgba()));
  for (const [id, d] of file.materials) if (!wroteMatl.has(id)) body.chunk('MATL', (o) => writeMatl(o, id, d));
  if (!wrote.has('rOBJ')) writeObjects();
  if (!wrote.has('rCAM')) writeCameras();

  const content = body.data;
  const out = new Out();
  out.id('VOX ');
  out.int32(200);
  out.id('MAIN');
  out.int32(0);
  out.int32(content.length);
  out.bytes(content);
  return out.data;
}

function defaultTrailing(file: VoxFile): { id: string; content: Uint8Array }[] {
  const layers = [...file.layers.values()].map((l) => {
    const o = new Out();
    o.int32(l.id);
    o.dict(l.attrs);
    o.int32(-1);
    return { id: 'LAYR', content: o.data };
  });
  return layers;
}
