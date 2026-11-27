// Camera rays and projection on the CPU, matching the path tracer's cameraRay(), plus a voxel
// grid ray cast for picking what's under the cursor.

import type { FrameParams, Vec3 } from '../render/renderer';
import type { VoxelGrid } from '../vox/scene';

type Camera = FrameParams['camera'];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Ray through a point of the image; u, v in 0..1 from the top-left. */
export function cameraRay(cam: Camera, u: number, v: number, aspect: number): { origin: Vec3; dir: Vec3 } {
  const nx = u * 2 - 1, ny = 1 - v * 2, k = cam.scale;
  const off = (i: number) => cam.right[i] * nx * k * aspect + cam.up[i] * ny * k;
  if (cam.orthographic) return { origin: [0, 1, 2].map((i) => cam.position[i] + off(i)) as Vec3, dir: cam.forward };
  const d = [0, 1, 2].map((i) => cam.forward[i] + off(i)) as Vec3;
  const l = Math.hypot(...d);
  return { origin: cam.position, dir: [d[0] / l, d[1] / l, d[2] / l] };
}

/** World point -> image u, v (0..1 from the top-left), or null when behind the camera. */
export function project(cam: Camera, p: Vec3, aspect: number): [number, number] | null {
  const d: Vec3 = [p[0] - cam.position[0], p[1] - cam.position[1], p[2] - cam.position[2]];
  const z = dot(d, cam.forward);
  const k = cam.scale;
  let nx: number, ny: number;
  if (cam.orthographic) {
    nx = dot(d, cam.right) / (k * aspect);
    ny = dot(d, cam.up) / k;
  } else {
    if (z < 1e-3) return null;
    nx = dot(d, cam.right) / (z * k * aspect);
    ny = dot(d, cam.up) / (z * k);
  }
  return [(nx + 1) / 2, (1 - ny) / 2];
}

export interface GridHit {
  /** World voxel coordinates of the hit cell (on the ground: the cell just below it). */
  cell: [number, number, number];
  /** Unit normal of the face that was hit (world axes). */
  normal: [number, number, number];
  ground: boolean;
  t: number;
}

/** First filled voxel along the ray, else the ground plane at the bottom of the grid. */
export function castRay(grid: VoxelGrid, origin: Vec3, dir: Vec3, ground = true): GridHit | null {
  const o = grid.origin, n = grid.dims;
  const ro: Vec3 = [origin[0] - o[0], origin[1] - o[1], origin[2] - o[2]];
  // Clip to the grid box.
  let t0 = 0, t1 = Infinity, enterAxis = -1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-12) {
      if (ro[i] < 0 || ro[i] > n[i]) { t0 = Infinity; break; }
      continue;
    }
    let a = (0 - ro[i]) / dir[i], b = (n[i] - ro[i]) / dir[i];
    if (a > b) [a, b] = [b, a];
    if (a > t0) { t0 = a; enterAxis = i; }
    t1 = Math.min(t1, b);
  }
  if (t0 <= t1) {
    const p = [0, 1, 2].map((i) => ro[i] + dir[i] * (t0 + 1e-6));
    const c = p.map((v, i) => Math.min(n[i] - 1, Math.max(0, Math.floor(v))));
    const step = dir.map((d) => (d > 0 ? 1 : -1));
    const tMax = [0, 1, 2].map((i) => (Math.abs(dir[i]) < 1e-12 ? Infinity : (c[i] + (step[i] > 0 ? 1 : 0) - ro[i]) / dir[i]));
    const tDelta = dir.map((d) => (Math.abs(d) < 1e-12 ? Infinity : Math.abs(1 / d)));
    let axis = enterAxis, t = t0;
    for (let guard = 0; guard < n[0] + n[1] + n[2] + 3; guard++) {
      if (grid.get(c[0], c[1], c[2])) {
        const normal: [number, number, number] = [0, 0, 0];
        if (axis >= 0) normal[axis] = -step[axis];
        else normal[2] = 1; // camera inside the grid
        return { cell: [c[0] + o[0], c[1] + o[1], c[2] + o[2]], normal, ground: false, t };
      }
      axis = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
      t = tMax[axis];
      if (t > t1) break;
      c[axis] += step[axis];
      tMax[axis] += tDelta[axis];
      if (c[axis] < 0 || c[axis] >= n[axis]) break;
    }
  }
  if (ground && dir[2] < -1e-6) {
    const t = (o[2] - origin[2]) / dir[2];
    if (t > 0) {
      const x = Math.floor(origin[0] + dir[0] * t), y = Math.floor(origin[1] + dir[1] * t);
      return { cell: [x, y, o[2] - 1], normal: [0, 0, 1], ground: true, t };
    }
  }
  return null;
}

/** Where a ray crosses the plane `axis = value` (world), as the voxel containing that point. */
export function planeCell(origin: Vec3, dir: Vec3, axis: number, value: number): [number, number, number] | null {
  if (Math.abs(dir[axis]) < 1e-9) return null;
  const t = (value - origin[axis]) / dir[axis];
  if (t <= 0) return null;
  return [0, 1, 2].map((i) => (i === axis ? Math.floor(value) : Math.floor(origin[i] + dir[i] * t))) as [number, number, number];
}
