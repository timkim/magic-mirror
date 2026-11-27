// Small isometric pictures of assets, drawn on a 2D canvas (no GPU, so they appear instantly
// and the same in every browser). Voxels are drawn back to front with three shaded faces.

import type { VoxFile } from '../vox/types';
import { buildVoxelGrid } from '../vox/scene';

export function isoThumbnail(file: VoxFile, size = 112): string {
  const g = buildVoxelGrid(file);
  const vox: [number, number, number, number][] = [];
  g.forEach((x, y, z, c) => vox.push([x, y, z, c]));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  if (!vox.length) return canvas.toDataURL();
  // View from +X, -Y, +Z: screen x along (x + y), screen y down along (x - y) and -z.
  const sx = (x: number, y: number) => (x + y) * 0.866;
  const sy = (x: number, y: number, z: number) => (x - y) * 0.5 - z;
  const [dx, dy, dz] = g.dims;
  const corners = [0, dx].flatMap((x) => [0, dy].flatMap((y) => [0, dz].map((z) => [sx(x, y), sy(x, y, z)])));
  const minX = Math.min(...corners.map((c) => c[0])), maxX = Math.max(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1])), maxY = Math.max(...corners.map((c) => c[1]));
  const k = (size * 0.9) / Math.max(maxX - minX, maxY - minY);
  const ox = (size - (maxX - minX) * k) / 2 - minX * k, oy = (size - (maxY - minY) * k) / 2 - minY * k;
  const P = (x: number, y: number, z: number): [number, number] => [ox + sx(x, y) * k, oy + sy(x, y, z) * k];
  // Far to near: low x+... the viewer looks from +x, -y, +z.
  vox.sort((a, b) => a[0] - a[1] + a[2] - (b[0] - b[1] + b[2]));
  const filled = (x: number, y: number, z: number) => g.get(x, y, z) !== 0;
  const shade = (c: number, f: number) => {
    const p = file.palette;
    return `rgb(${Math.round(p[c * 4] * f)},${Math.round(p[c * 4 + 1] * f)},${Math.round(p[c * 4 + 2] * f)})`;
  };
  const quad = (pts: [number, number][], fill: string) => {
    ctx.beginPath();
    ctx.moveTo(...pts[0]);
    for (const q of pts.slice(1)) ctx.lineTo(...q);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = fill;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  };
  for (const [x, y, z, c] of vox) {
    if (!filled(x, y, z + 1)) quad([P(x, y, z + 1), P(x + 1, y, z + 1), P(x + 1, y + 1, z + 1), P(x, y + 1, z + 1)], shade(c, 1));
    if (!filled(x + 1, y, z)) quad([P(x + 1, y, z), P(x + 1, y + 1, z), P(x + 1, y + 1, z + 1), P(x + 1, y, z + 1)], shade(c, 0.78));
    if (!filled(x, y - 1, z)) quad([P(x, y, z), P(x + 1, y, z), P(x + 1, y, z + 1), P(x, y, z + 1)], shade(c, 0.62));
  }
  return canvas.toDataURL('image/png');
}
