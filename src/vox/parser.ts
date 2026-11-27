// Reader for MagicaVoxel .vox files (spec: github.com/ephtracy/voxel-model, MIT).
// Handles models, palette, materials (MATL), scene graph (nTRN/nGRP/nSHP), layers,
// render settings (rOBJ) and cameras (rCAM). Unknown chunks are skipped and listed.

import type { Rot3, SceneNode, VoxDict, VoxFile, VoxModel } from './types';

class Reader {
  private view: DataView;
  pos = 0;
  constructor(private bytes: Uint8Array, start = 0, private end = bytes.length) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = start;
  }
  get remaining() {
    return this.end - this.pos;
  }
  int32() {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  id() {
    this.need(4);
    const s = String.fromCharCode(...this.bytes.subarray(this.pos, this.pos + 4));
    this.pos += 4;
    return s;
  }
  string() {
    const n = this.int32();
    this.need(n);
    const s = new TextDecoder().decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
  dict(): VoxDict {
    const n = this.int32();
    const d: VoxDict = {};
    for (let i = 0; i < n; i++) {
      const k = this.string();
      d[k] = this.string();
    }
    return d;
  }
  slice(n: number) {
    this.need(n);
    const s = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  private need(n: number) {
    if (this.pos + n > this.end) throw new Error(`Unexpected end of .vox data at byte ${this.pos}`);
  }
}

/** Inverse of decodeRotation. */
export function encodeRotation(m: Rot3): number {
  let r = 0;
  for (let row = 0; row < 3; row++) {
    const col = [0, 1, 2].find((c) => m[row * 3 + c] !== 0) ?? row;
    if (row === 0) r |= col;
    if (row === 1) r |= col << 2;
    if (m[row * 3 + col] < 0) r |= 16 << row;
  }
  return r;
}

/** Decode the nTRN `_r` rotation byte into a row-major 3x3 matrix. */
export function decodeRotation(r: number): Rot3 {
  const c0 = r & 3;
  const c1 = (r >> 2) & 3;
  const c2 = 3 - c0 - c1;
  const m: Rot3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  m[0 * 3 + c0] = r & 16 ? -1 : 1;
  m[1 * 3 + c1] = r & 32 ? -1 : 1;
  m[2 * 3 + c2] = r & 64 ? -1 : 1;
  return m;
}

export const IDENTITY_ROT: Rot3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function parseVec3(s: string | undefined): [number, number, number] {
  if (!s) return [0, 0, 0];
  const p = s.trim().split(/\s+/).map(Number);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
}

export function parseVox(input: ArrayBuffer | Uint8Array): VoxFile {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const r = new Reader(bytes);
  if (r.id() !== 'VOX ') throw new Error('Not a MagicaVoxel .vox file');
  const version = r.int32();

  const file: VoxFile = {
    version,
    models: [],
    palette: defaultPalette(),
    materials: new Map(),
    nodes: new Map(),
    layers: new Map(),
    renderObjects: [],
    cameras: [],
    unknownChunks: [],
  };

  let pendingSize: [number, number, number] | null = null;

  // Chunks are nested: MAIN holds everything else as children. We walk linearly,
  // stepping into children rather than skipping them.
  const walk = (end: number) => {
    while (r.pos < end) {
      const id = r.id();
      const contentSize = r.int32();
      const childrenSize = r.int32();
      const contentStart = r.pos;
      const contentEnd = contentStart + contentSize;
      const c = new Reader(bytes, contentStart, contentEnd);
      if (!['MAIN', 'SIZE', 'XYZI', 'nTRN', 'nGRP', 'nSHP'].includes(id))
        (file.trailing ??= []).push({ id, content: bytes.slice(contentStart, contentEnd) });

      switch (id) {
        case 'MAIN':
          break;
        case 'SIZE':
          pendingSize = [c.int32(), c.int32(), c.int32()];
          break;
        case 'XYZI': {
          const n = c.int32();
          const voxels = c.slice(n * 4).slice(); // copy
          const model: VoxModel = { size: pendingSize ?? [0, 0, 0], voxels };
          file.models.push(model);
          pendingSize = null;
          break;
        }
        case 'RGBA': {
          const raw = c.slice(Math.min(1024, contentSize));
          const pal = new Uint8Array(1024);
          // Entry k in the chunk is colour index k+1.
          for (let k = 0; k < 255; k++) pal.set(raw.subarray(k * 4, k * 4 + 4), (k + 1) * 4);
          file.palette = pal;
          if (raw.length >= 1024) file.paletteTail = raw.slice(1020, 1024);
          break;
        }
        case 'MATL': {
          const matId = c.int32();
          file.materials.set(matId, c.dict());
          break;
        }
        case 'nTRN': {
          const nid = c.int32();
          const attrs = c.dict();
          const childId = c.int32();
          c.int32(); // reserved
          const layerId = c.int32();
          const nFrames = c.int32();
          const frames = [];
          for (let i = 0; i < nFrames; i++) {
            const f = c.dict();
            frames.push({
              rotation: f._r !== undefined ? decodeRotation(Number(f._r)) : IDENTITY_ROT,
              translation: parseVec3(f._t),
              frame: f._f !== undefined ? Number(f._f) : undefined,
              attrs: f,
            });
          }
          if (frames.length === 0) frames.push({ rotation: IDENTITY_ROT, translation: [0, 0, 0] as [number, number, number], frame: undefined });
          file.nodes.set(nid, { kind: 'transform', id: nid, attrs, childId, layerId, frames });
          break;
        }
        case 'nGRP': {
          const nid = c.int32();
          const attrs = c.dict();
          const n = c.int32();
          const childIds = [];
          for (let i = 0; i < n; i++) childIds.push(c.int32());
          file.nodes.set(nid, { kind: 'group', id: nid, attrs, childIds });
          break;
        }
        case 'nSHP': {
          const nid = c.int32();
          const attrs = c.dict();
          const n = c.int32();
          const models = [];
          for (let i = 0; i < n; i++) {
            const modelId = c.int32();
            const d = c.dict();
            models.push({ modelId, frame: d._f !== undefined ? Number(d._f) : undefined, attrs: d });
          }
          file.nodes.set(nid, { kind: 'shape', id: nid, attrs, models } as SceneNode);
          break;
        }
        case 'LAYR': {
          const lid = c.int32();
          const attrs = c.dict();
          file.layers.set(lid, { id: lid, attrs, hidden: attrs._hidden === '1' });
          break;
        }
        case 'rOBJ':
          file.renderObjects.push(c.dict());
          break;
        case 'rCAM': {
          const cid = c.int32();
          file.cameras.push({ id: cid, attrs: c.dict() });
          break;
        }
        default:
          if (!file.unknownChunks.includes(id)) file.unknownChunks.push(id);
      }

      r.pos = contentEnd;
      if (childrenSize > 0) walk(contentEnd + childrenSize);
    }
  };

  walk(bytes.length);
  return file;
}

/** Look up a render-settings dict by its `_type` (e.g. "_inf" sun, "_uni" sky, "_lens"). */
export function renderObject(file: VoxFile, type: string): VoxDict | undefined {
  return file.renderObjects.find((d) => d._type === type);
}

/** Fallback palette for very old files without an RGBA chunk: a neutral ramp. */
function defaultPalette(): Uint8Array {
  const p = new Uint8Array(1024);
  for (let i = 1; i < 256; i++) {
    const v = 255 - Math.round(((i - 1) / 254) * 200);
    p.set([v, v, v, 255], i * 4);
  }
  return p;
}

export { parseVec3 };
