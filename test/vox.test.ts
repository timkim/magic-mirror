import { describe, expect, it } from 'vitest';
import { decodeRotation, parseVox, renderObject } from '../src/vox/parser';
import { buildVoxelGrid, placeModels } from '../src/vox/scene';
import { writeVox } from '../src/vox/writer';
import { settingsFromVox } from '../src/vox/renderSettings';

const apply = (r: number, v: [number, number, number]) => {
  const m = decodeRotation(r);
  return [0, 1, 2].map((i) => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2]);
};

describe('rotation byte', () => {
  it('decodes the documented z rotations', () => {
    expect(apply(4, [1, 0, 0])).toEqual([1, 0, 0]); // 0°
    expect(apply(17, [1, 0, 0])).toEqual([0, 1, 0]); // 90°
    expect(apply(52, [1, 0, 0])).toEqual([-1, 0, 0]); // 180°
    expect(apply(33, [1, 0, 0])).toEqual([0, -1, 0]); // 270°
    for (const r of [4, 17, 52, 33]) expect(apply(r, [0, 0, 1])).toEqual([0, 0, 1]);
  });
});

describe('parse + scene', () => {
  const bytes = writeVox({
    objects: [
      { name: 'a', size: [2, 2, 2], voxels: [[0, 0, 0, 3], [1, 1, 1, 5]], translation: [10, 0, 1] },
      { name: 'b', size: [3, 1, 1], voxels: [[0, 0, 0, 7], [2, 0, 0, 7]], translation: [0, 0, 0], rotation: 17 },
    ],
    palette: { 3: [255, 0, 0], 5: [0, 255, 0] },
    materials: { 7: { _type: '_metal', _rough: '0.2' } },
    renderObjects: [{ _type: '_inf', _i: '0.9', _k: '255 128 0', _angle: '40 60' }],
    cameras: [{ id: 0, attrs: { _mode: 'pers', _focus: '1 2 3', _angle: '30 20 0', _radius: '50', _fov: '45' } }],
  });
  const file = parseVox(bytes);

  it('reads models, palette and materials', () => {
    expect(file.version).toBe(200);
    expect(file.models).toHaveLength(2);
    expect(file.models[0].size).toEqual([2, 2, 2]);
    expect(Array.from(file.palette.subarray(3 * 4, 3 * 4 + 4))).toEqual([255, 0, 0, 255]);
    expect(file.materials.get(7)?._type).toBe('_metal');
    expect(renderObject(file, '_inf')?._i).toBe('0.9');
  });

  it('places models through the scene graph', () => {
    const placed = placeModels(file);
    expect(placed.map((p) => p.name)).toEqual(['a', 'b']);
    expect(placed[0].translation).toEqual([10, 0, 1]);
  });

  it('bakes world voxels with the floor(size/2) pivot and rotation', () => {
    const g = buildVoxelGrid(file);
    const at = (x: number, y: number, z: number) =>
      g.cells[(x - g.origin[0]) + g.dims[0] * ((y - g.origin[1]) + g.dims[1] * (z - g.origin[2]))];
    // Model a: voxel (0,0,0) - pivot (1,1,1) + (10,0,1) = (9,-1,0)
    expect(at(9, -1, 0)).toBe(3);
    expect(at(10, 0, 1)).toBe(5);
    // Model b rotated 90° about z: voxel (0,0,0) - (1,0,0) = (-1,0,0) -> (0,-1,0); (2,0,0) -> (1,0,0) -> (0,1,0)
    expect(at(0, -1, 0)).toBe(7);
    expect(at(0, 1, 0)).toBe(7);
    expect(g.voxelCount).toBe(4);
  });

  it('maps stored render settings and camera', () => {
    const s = settingsFromVox(file);
    expect(s['sun.intensity']).toBe(0.9);
    expect(s['sun.pitch']).toBe(40);
    expect(s['cam.target']).toEqual([1, 2, 3]);
    expect(s['cam.distance']).toBe(50);
    expect(s['cam.yaw']).toBe(-20);
  });
});
