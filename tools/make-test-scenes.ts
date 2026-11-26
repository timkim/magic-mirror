// Generates the feature test scenes in test-scenes/. Each scene isolates one part of the
// look so it can be compared against a MagicaVoxel render of the same file.
//
//   npm run scenes

import { mkdirSync, writeFileSync } from 'node:fs';
import { writeVox, type WriterObject } from '../src/vox/writer';

type V = [number, number, number, number];

function box(sx: number, sy: number, sz: number, c: number): V[] {
  const v: V[] = [];
  for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) v.push([x, y, z, c]);
  return v;
}

function sphere(r: number, c: number): { size: [number, number, number]; voxels: V[] } {
  const d = r * 2;
  const v: V[] = [];
  for (let z = 0; z < d; z++) for (let y = 0; y < d; y++) for (let x = 0; x < d; x++) {
    const dx = x - r + 0.5, dy = y - r + 0.5, dz = z - r + 0.5;
    if (dx * dx + dy * dy + dz * dz <= r * r) v.push([x, y, z, c]);
  }
  return { size: [d, d, d], voxels: v };
}

const palette: Record<number, [number, number, number]> = {
  1: [235, 235, 235], // white
  2: [220, 60, 50], // red
  3: [60, 170, 80], // green
  4: [60, 100, 220], // blue
  5: [240, 190, 40], // yellow
  6: [200, 200, 210], // metal grey
  7: [255, 170, 60], // emissive orange
  8: [120, 220, 255], // emissive cyan
  9: [90, 90, 95], // dark floor
};

const scenes: Record<string, Parameters<typeof writeVox>[0]> = {};

// 1. Diffuse + sky/sun: coloured blocks, a staircase and a sphere on a slab.
{
  const stairs: V[] = [];
  for (let s = 0; s < 6; s++) stairs.push(...box(4, 12, s * 2 + 2, 5).map(([x, y, z, c]) => [x + s * 4, y, z, c] as V));
  const ball = sphere(7, 1);
  const objects: WriterObject[] = [
    { name: 'slab', size: [64, 64, 2], voxels: box(64, 64, 2, 1), translation: [0, 0, 1] },
    { name: 'red', size: [12, 12, 12], voxels: box(12, 12, 12, 2), translation: [-16, -14, 8] },
    { name: 'green', size: [8, 8, 20], voxels: box(8, 8, 20, 3), translation: [14, -16, 12] },
    { name: 'blue', size: [16, 6, 6], voxels: box(16, 6, 6, 4), translation: [-12, 16, 5] },
    { name: 'stairs', size: [24, 12, 12], voxels: stairs, translation: [12, 14, 8] },
    { name: 'ball', ...ball, translation: [0, 0, 9] },
  ];
  scenes['01-diffuse'] = {
    objects,
    palette,
    renderObjects: [
      { _type: '_inf', _i: '0.7', _k: '255 255 255', _angle: '50 50', _area: '0.07', _disk: '0' },
      { _type: '_uni', _i: '0.6', _k: '255 255 255' },
    ],
  };
}

// 2. Materials: diffuse, smooth metal, rough metal, two emitters.
{
  const objs: WriterObject[] = [{ name: 'floor', size: [80, 40, 1], voxels: box(80, 40, 1, 9), translation: [0, 0, 0] }];
  const spec: [string, number, number][] = [['diffuse', 1, -30], ['metal-smooth', 6, -12], ['metal-rough', 2, 6], ['emit-orange', 7, 22]];
  for (const [name, c, x] of spec) objs.push({ name, ...sphere(7, c), translation: [x, 0, 7] });
  objs.push({ name: 'emit-cyan', size: [4, 4, 4], voxels: box(4, 4, 4, 8), translation: [34, 10, 2] });
  scenes['02-materials'] = {
    objects: objs,
    palette,
    materials: {
      6: { _type: '_metal', _metal: '1', _rough: '0.02' },
      2: { _type: '_metal', _metal: '1', _rough: '0.4' },
      7: { _type: '_emit', _emit: '1', _flux: '1' },
      8: { _type: '_emit', _emit: '1', _flux: '2' },
    },
  };
}

// 3. Scene graph rotations: one L-shaped piece placed at 0°, 90°, 180° and 270° around Z.
{
  const L: V[] = [...box(10, 3, 3, 2), ...box(3, 6, 3, 4).map(([x, y, z, c]) => [x, y + 3, z, c] as V), [9, 0, 3, 5]];
  const objs: WriterObject[] = [{ name: 'floor', size: [48, 48, 1], voxels: box(48, 48, 1, 1), translation: [0, 0, 0] }];
  const rots: [number, [number, number]][] = [[4, [10, 10]], [17, [-10, 10]], [52, [-10, -10]], [33, [10, -10]]];
  for (const [r, [x, y]] of rots) objs.push({ name: `L-r${r}`, size: [10, 9, 4], voxels: L, translation: [x, y, 3], rotation: r });
  scenes['03-rotations'] = { objects: objs, palette };
}

mkdirSync('test-scenes', { recursive: true });
for (const [name, scene] of Object.entries(scenes)) {
  writeFileSync(`test-scenes/${name}.vox`, writeVox(scene));
  console.log(`test-scenes/${name}.vox`);
}
