// Voxel shapes (box, sphere, cylinder, line) as lists of cells, in whatever coordinates the
// caller uses. Used by the editor's Line and Sphere brushes and the assistant's draw_shapes.

type V3 = [number, number, number];

export interface Shape {
  shape: 'box' | 'sphere' | 'cylinder' | 'line';
  from?: V3; to?: V3; center?: V3; radius?: number; height?: number;
  color?: number; mode?: 'set' | 'add' | 'paint' | 'erase'; hollow?: boolean;
}

/** Cells (model coordinates, unclipped) covered by a shape. */
export function shapeCells(sh: Shape): V3[] {
  let lo: V3, hi: V3, inside: (x: number, y: number, z: number) => boolean;
  const r = Math.max(0, sh.radius ?? 0);
  if (sh.shape === 'box') {
    const a = sh.from ?? [0, 0, 0], b = sh.to ?? a;
    lo = a.map((v, i) => Math.round(Math.min(v, b[i]))) as V3;
    hi = a.map((v, i) => Math.round(Math.max(v, b[i]))) as V3;
    inside = (x, y, z) => x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2];
  } else if (sh.shape === 'sphere') {
    const c = sh.center ?? [0, 0, 0], rr = (r + 0.5) ** 2;
    lo = c.map((v) => Math.floor(v - r - 1)) as V3;
    hi = c.map((v) => Math.ceil(v + r + 1)) as V3;
    inside = (x, y, z) => (x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2 <= rr;
  } else if (sh.shape === 'cylinder') {
    const c = sh.center ?? [0, 0, 0], h = Math.max(1, Math.round(sh.height ?? 1)), rr = (r + 0.5) ** 2;
    lo = [Math.floor(c[0] - r - 1), Math.floor(c[1] - r - 1), Math.round(c[2])];
    hi = [Math.ceil(c[0] + r + 1), Math.ceil(c[1] + r + 1), Math.round(c[2]) + h - 1];
    inside = (x, y, z) => z >= lo[2] && z <= hi[2] && (x - c[0]) ** 2 + (y - c[1]) ** 2 <= rr;
  } else {
    const a = sh.from ?? [0, 0, 0], b = sh.to ?? a, rr = (r + 0.5) ** 2;
    const d = b.map((v, i) => v - a[i]), len2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1;
    lo = a.map((v, i) => Math.floor(Math.min(v, b[i]) - r - 1)) as V3;
    hi = a.map((v, i) => Math.ceil(Math.max(v, b[i]) + r + 1)) as V3;
    inside = (x, y, z) => {
      const t = Math.max(0, Math.min(1, ((x - a[0]) * d[0] + (y - a[1]) * d[1] + (z - a[2]) * d[2]) / len2));
      return (x - a[0] - d[0] * t) ** 2 + (y - a[1] - d[1] * t) ** 2 + (z - a[2] - d[2] * t) ** 2 <= Math.max(rr, 0.75);
    };
  }
  const vol = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
  if (vol > 20_000_000) throw new Error(`A ${sh.shape} that big (${vol.toLocaleString()} cells) is too large.`);
  const out: V3[] = [];
  for (let z = lo[2]; z <= hi[2]; z++)
    for (let y = lo[1]; y <= hi[1]; y++)
      for (let x = lo[0]; x <= hi[0]; x++) {
        if (!inside(x, y, z)) continue;
        if (sh.hollow && inside(x + 1, y, z) && inside(x - 1, y, z) && inside(x, y + 1, z) && inside(x, y - 1, z) && inside(x, y, z + 1) && inside(x, y, z - 1)) continue;
        out.push([x, y, z]);
      }
  return out;
}

