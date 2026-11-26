// Flattens a .vox scene graph into one world-space voxel grid at a given animation frame.

import type { Rot3, SceneNode, VoxFile } from './types';
import { IDENTITY_ROT } from './parser';

export interface PlacedModel {
  modelId: number;
  rotation: Rot3;
  translation: [number, number, number];
  name?: string;
}

export interface VoxelGrid {
  /** World coordinate of grid cell (0,0,0). */
  origin: [number, number, number];
  dims: [number, number, number];
  /** One byte per cell: palette index, 0 = empty. Index = x + dims.x * (y + dims.y * z). */
  cells: Uint8Array;
  voxelCount: number;
}

function mulRot(a: Rot3, b: Rot3): Rot3 {
  const o = [0, 0, 0, 0, 0, 0, 0, 0, 0] as Rot3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}

function applyRot(m: Rot3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Pose of a transform node at `time`: translation interpolates linearly, rotation steps. */
function poseAt(node: Extract<SceneNode, { kind: 'transform' }>, time: number) {
  const frames = node.frames;
  if (frames.length === 1 || frames[0].frame === undefined) return frames[0];
  const sorted = [...frames].sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0));
  if (time <= (sorted[0].frame ?? 0)) return sorted[0];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    const fa = a.frame ?? 0, fb = b.frame ?? 0;
    if (time >= fa && time < fb) {
      const k = (time - fa) / (fb - fa);
      return {
        rotation: a.rotation,
        translation: [0, 1, 2].map((j) => Math.round(a.translation[j] + (b.translation[j] - a.translation[j]) * k)) as [number, number, number],
      };
    }
  }
  return sorted[sorted.length - 1];
}

function shapeModelAt(node: Extract<SceneNode, { kind: 'shape' }>, time: number): number | undefined {
  const ms = node.models;
  if (ms.length === 0) return undefined;
  if (ms.length === 1 || ms[0].frame === undefined) return ms[0].modelId;
  const sorted = [...ms].sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0));
  let t = time;
  if (node.attrs._loop === '1') {
    const span = (sorted[sorted.length - 1].frame ?? 0) + 1;
    t = ((time % span) + span) % span;
  }
  let pick = sorted[0];
  for (const m of sorted) if ((m.frame ?? 0) <= t) pick = m;
  return pick.modelId;
}

/** Walk the scene graph from root node 0 and list every visible model with its world transform. */
export function placeModels(file: VoxFile, time = 0): PlacedModel[] {
  const out: PlacedModel[] = [];
  if (file.nodes.size === 0) {
    // Old files without a scene graph: one model at the origin.
    file.models.forEach((_, i) => out.push({ modelId: i, rotation: IDENTITY_ROT, translation: [0, 0, 0] }));
    return out;
  }
  const visit = (id: number, rot: Rot3, tr: [number, number, number], name: string | undefined, depth: number) => {
    const node = file.nodes.get(id);
    if (!node || depth > 256) return;
    if (node.attrs._hidden === '1') return;
    if (node.kind === 'transform') {
      if (file.layers.get(node.layerId)?.hidden) return;
      const p = poseAt(node, time);
      const t = applyRot(rot, p.translation);
      visit(node.childId, mulRot(rot, p.rotation), [tr[0] + t[0], tr[1] + t[1], tr[2] + t[2]], node.attrs._name ?? name, depth + 1);
    } else if (node.kind === 'group') {
      for (const c of node.childIds) visit(c, rot, tr, name, depth + 1);
    } else {
      const modelId = shapeModelAt(node, time);
      if (modelId !== undefined && file.models[modelId]) out.push({ modelId, rotation: rot, translation: tr, name });
    }
  };
  visit(0, IDENTITY_ROT, [0, 0, 0], undefined, 0);
  return out;
}

/**
 * Bake placed models into one dense grid.
 * A voxel v of a model lands at R * (v - floor(size / 2)) + T  (MagicaVoxel's pivot rule).
 * TODO(match): confirm the off-by-one for rotated even-sized models against MagicaVoxel renders.
 */
export function buildVoxelGrid(file: VoxFile, time = 0, maxCells = 1024 ** 3): VoxelGrid {
  const placed = placeModels(file, time);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const transformVoxel = (p: PlacedModel, x: number, y: number, z: number) => {
    const s = file.models[p.modelId].size;
    const w = applyRot(p.rotation, [x - Math.floor(s[0] / 2), y - Math.floor(s[1] / 2), z - Math.floor(s[2] / 2)]);
    return [w[0] + p.translation[0], w[1] + p.translation[1], w[2] + p.translation[2]];
  };
  // Bounds from each model's 8 corners.
  for (const p of placed) {
    const s = file.models[p.modelId].size;
    for (const cx of [0, s[0] - 1]) for (const cy of [0, s[1] - 1]) for (const cz of [0, s[2] - 1]) {
      const w = transformVoxel(p, cx, cy, cz);
      for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], w[i]); hi[i] = Math.max(hi[i], w[i]); }
    }
  }
  if (placed.length === 0) return { origin: [0, 0, 0], dims: [1, 1, 1], cells: new Uint8Array(1), voxelCount: 0 };

  const dims: [number, number, number] = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
  const total = dims[0] * dims[1] * dims[2];
  if (total > maxCells) throw new Error(`Scene bounds ${dims.join('×')} are too large for the dense grid (sparse bricks are planned).`);
  const cells = new Uint8Array(total);
  let count = 0;
  for (const p of placed) {
    const v = file.models[p.modelId].voxels;
    for (let i = 0; i < v.length; i += 4) {
      const w = transformVoxel(p, v[i], v[i + 1], v[i + 2]);
      const idx = (w[0] - lo[0]) + dims[0] * ((w[1] - lo[1]) + dims[1] * (w[2] - lo[2]));
      if (cells[idx] === 0) count++;
      cells[idx] = v[i + 3];
    }
  }
  return { origin: [lo[0], lo[1], lo[2]], dims, cells, voxelCount: count };
}

/** Highest keyframe number in the scene, for animation timelines. */
export function animationLength(file: VoxFile): number {
  let max = 0;
  for (const n of file.nodes.values()) {
    if (n.kind === 'transform') for (const f of n.frames) max = Math.max(max, f.frame ?? 0);
    if (n.kind === 'shape') for (const m of n.models) max = Math.max(max, m.frame ?? 0);
  }
  return max;
}
