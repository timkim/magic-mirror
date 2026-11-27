// Flattens a .vox scene graph into one world-space voxel grid at a given animation frame.

import type { Rot3, SceneNode, VoxFile } from './types';
import { IDENTITY_ROT } from './parser';
import { SparseGrid } from './grid';

export interface PlacedModel {
  modelId: number;
  rotation: Rot3;
  translation: [number, number, number];
  name?: string;
  /** The transform node directly above the shape (what moving or animating this object edits). */
  nodeId?: number;
}

/** The baked scene: a sparse grid of palette indices (see grid.ts). */
export type VoxelGrid = SparseGrid;

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
  const visit = (id: number, rot: Rot3, tr: [number, number, number], name: string | undefined, depth: number, nodeId?: number) => {
    const node = file.nodes.get(id);
    if (!node || depth > 256) return;
    if (node.attrs._hidden === '1') return;
    if (node.kind === 'transform') {
      if (file.layers.get(node.layerId)?.hidden) return;
      const p = poseAt(node, time);
      const t = applyRot(rot, p.translation);
      visit(node.childId, mulRot(rot, p.rotation), [tr[0] + t[0], tr[1] + t[1], tr[2] + t[2]], node.attrs._name ?? name, depth + 1, node.id);
    } else if (node.kind === 'group') {
      for (const c of node.childIds) visit(c, rot, tr, name, depth + 1);
    } else {
      const modelId = shapeModelAt(node, time);
      if (modelId !== undefined && file.models[modelId]) out.push({ modelId, rotation: rot, translation: tr, name, nodeId });
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
export function buildVoxelGrid(file: VoxFile, time = 0): VoxelGrid {
  const placed = placeModels(file, time);
  if (placed.length === 0) return new SparseGrid([0, 0, 0], [1, 1, 1]);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of placed) {
    const b = placementBounds(file, p);
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b.lo[i]); hi[i] = Math.max(hi[i], b.hi[i]); }
  }
  const grid = new SparseGrid([lo[0], lo[1], lo[2]], [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1]);
  for (const p of placed) {
    const v = file.models[p.modelId].voxels;
    for (let i = 0; i < v.length; i += 4) {
      const w = transformVoxel(file, p, v[i], v[i + 1], v[i + 2]);
      grid.set(w[0] - lo[0], w[1] - lo[1], w[2] - lo[2], v[i + 3]);
    }
  }
  return grid;
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

/** Inclusive box in grid cell coordinates. */
export interface GridBox {
  min: [number, number, number];
  max: [number, number, number];
}

export function transformVoxel(file: VoxFile, p: PlacedModel, x: number, y: number, z: number): [number, number, number] {
  const s = file.models[p.modelId].size;
  const w = applyRot(p.rotation, [x - Math.floor(s[0] / 2), y - Math.floor(s[1] / 2), z - Math.floor(s[2] / 2)]);
  return [w[0] + p.translation[0], w[1] + p.translation[1], w[2] + p.translation[2]];
}

/** World-space inclusive bounds of a placed model. */
export function placementBounds(file: VoxFile, p: PlacedModel) {
  const s = file.models[p.modelId].size;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const cx of [0, s[0] - 1]) for (const cy of [0, s[1] - 1]) for (const cz of [0, s[2] - 1]) {
    const w = transformVoxel(file, p, cx, cy, cz);
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], w[i]); hi[i] = Math.max(hi[i], w[i]); }
  }
  return { lo, hi };
}

const samePlacement = (a: PlacedModel, b: PlacedModel) =>
  a.nodeId === b.nodeId && a.modelId === b.modelId && a.translation.every((v, i) => v === b.translation[i]) && a.rotation.every((v, i) => v === b.rotation[i]);

/**
 * Keeps one voxel grid for a whole animation. The grid's bounds cover every frame, so moving
 * to another frame only rewrites the regions where models moved or swapped (flipbooks),
 * and the renderer only re-uploads those regions.
 */
export class SceneBaker {
  readonly grid: VoxelGrid;
  readonly length: number;
  private placed: PlacedModel[];
  time: number;

  constructor(private file: VoxFile, time = 0) {
    this.length = animationLength(file);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let t = 0; t <= this.length; t++)
      for (const p of placeModels(file, t)) {
        const b = placementBounds(file, p);
        for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b.lo[i]); hi[i] = Math.max(hi[i], b.hi[i]); }
      }
    if (!Number.isFinite(lo[0])) { lo.fill(0); hi.fill(0); }
    const dims: [number, number, number] = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
    this.grid = new SparseGrid([lo[0], lo[1], lo[2]], dims);
    this.time = time;
    this.placed = placeModels(file, time);
    this.rebuild([{ min: [0, 0, 0], max: [dims[0] - 1, dims[1] - 1, dims[2] - 1] }]);
  }

  /** Move to another frame. Returns the regions that changed (empty when nothing moved). */
  setTime(time: number): GridBox[] {
    if (time === this.time) return [];
    const next = placeModels(this.file, time);
    const g = this.grid;
    const toGrid = (b: { lo: number[]; hi: number[] }): GridBox => ({
      min: [0, 1, 2].map((i) => Math.max(0, b.lo[i] - g.origin[i])) as [number, number, number],
      max: [0, 1, 2].map((i) => Math.min(g.dims[i] - 1, b.hi[i] - g.origin[i])) as [number, number, number],
    });
    let boxes: GridBox[] = [];
    if (next.length !== this.placed.length) {
      boxes = [{ min: [0, 0, 0], max: [g.dims[0] - 1, g.dims[1] - 1, g.dims[2] - 1] }];
    } else {
      for (let i = 0; i < next.length; i++) {
        if (samePlacement(next[i], this.placed[i])) continue;
        boxes.push(toGrid(placementBounds(this.file, this.placed[i])), toGrid(placementBounds(this.file, next[i])));
      }
    }
    this.placed = next;
    this.time = time;
    // Many scattered changes: one full rebuild is cheaper than many small ones.
    const volume = boxes.reduce((n, b) => n + (b.max[0] - b.min[0] + 1) * (b.max[1] - b.min[1] + 1) * (b.max[2] - b.min[2] + 1), 0);
    if (volume > (g.dims[0] * g.dims[1] * g.dims[2]) / 3) boxes = [{ min: [0, 0, 0], max: [g.dims[0] - 1, g.dims[1] - 1, g.dims[2] - 1] }];
    this.rebuild(boxes);
    return boxes;
  }

  /** Every model placed at the current frame, in scene order. */
  get placements(): readonly PlacedModel[] {
    return this.placed;
  }

  /**
   * After a model's voxels changed: re-stamp everywhere it's placed. Returns the changed grid
   * regions, or null when the model no longer fits the grid (rebuild the baker instead).
   * Size changes need a new baker too, since pivots move.
   */
  refreshModels(modelIds: number[]): GridBox[] | null {
    const g = this.grid;
    const boxes: GridBox[] = [];
    for (const p of this.placed) {
      if (!modelIds.includes(p.modelId)) continue;
      const b = placementBounds(this.file, p);
      for (let i = 0; i < 3; i++) if (b.lo[i] < g.origin[i] || b.hi[i] - g.origin[i] >= g.dims[i]) return null;
      boxes.push({
        min: [0, 1, 2].map((i) => b.lo[i] - g.origin[i]) as [number, number, number],
        max: [0, 1, 2].map((i) => b.hi[i] - g.origin[i]) as [number, number, number],
      });
    }
    this.rebuild(boxes);
    return boxes;
  }

  /** Clear each box and stamp every model that touches it (in scene order, like a full build). */
  private rebuild(boxes: GridBox[]) {
    const g = this.grid, o = g.origin;
    for (const b of boxes) {
      g.clearBox(b.min, b.max);
      for (const p of this.placed) {
        const pb = placementBounds(this.file, p);
        let touches = true;
        for (let i = 0; i < 3; i++) if (pb.hi[i] - o[i] < b.min[i] || pb.lo[i] - o[i] > b.max[i]) touches = false;
        if (!touches) continue;
        const v = this.file.models[p.modelId].voxels;
        for (let i = 0; i < v.length; i += 4) {
          const w = transformVoxel(this.file, p, v[i], v[i + 1], v[i + 2]);
          const x = w[0] - o[0], y = w[1] - o[1], z = w[2] - o[2];
          if (x < b.min[0] || x > b.max[0] || y < b.min[1] || y > b.max[1] || z < b.min[2] || z > b.max[2]) continue;
          g.set(x, y, z, v[i + 3]);
        }
      }
    }
  }
}

/** World voxel -> the model's own voxel coordinates (inverse of transformVoxel). */
export function worldToModel(file: VoxFile, p: PlacedModel, w: [number, number, number]): [number, number, number] {
  const s = file.models[p.modelId].size, r = p.rotation;
  const d = [w[0] - p.translation[0], w[1] - p.translation[1], w[2] - p.translation[2]];
  // Rotations are orthogonal, so the inverse is the transpose.
  return [0, 1, 2].map((j) => r[j] * d[0] + r[3 + j] * d[1] + r[6 + j] * d[2] + Math.floor(s[j] / 2)) as [number, number, number];
}
