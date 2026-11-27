// A new, empty scene: root transform -> group, one layer, a MagicaVoxel-style default palette.

import { IDENTITY_ROT } from './parser';
import type { VoxFile } from './types';

/**
 * Palette in MagicaVoxel's default layout: indices 1-215 are a 6-level colour cube
 * (white first, blue changing fastest), then 10-step ramps of red, green, blue and grey.
 */
export function defaultPalette(): Uint8Array {
  const p = new Uint8Array(1024);
  const levels = [255, 204, 153, 102, 51, 0];
  let i = 1;
  for (const r of levels) for (const g of levels) for (const b of levels) if (r || g || b) p.set([r, g, b, 255], 4 * i++);
  const ramp = [238, 221, 187, 170, 136, 119, 85, 68, 34, 17];
  for (const ch of [0, 1, 2]) for (const v of ramp) { const c = [0, 0, 0, 255]; c[ch] = v; p.set(c, 4 * i++); }
  for (const v of ramp) p.set([v, v, v, 255], 4 * i++);
  return p;
}

export function emptyScene(): VoxFile {
  return {
    version: 200,
    models: [],
    palette: defaultPalette(),
    materials: new Map(),
    nodes: new Map([
      [0, { kind: 'transform', id: 0, attrs: {}, childId: 1, layerId: -1, frames: [{ rotation: IDENTITY_ROT, translation: [0, 0, 0] }] }],
      [1, { kind: 'group', id: 1, attrs: {}, childIds: [] }],
    ]),
    layers: new Map([[0, { id: 0, attrs: {}, hidden: false }]]),
    renderObjects: [],
    cameras: [],
    unknownChunks: [],
  };
}
