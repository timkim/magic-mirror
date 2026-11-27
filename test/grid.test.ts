import { describe, expect, it } from 'vitest';
import { SparseGrid } from '../src/vox/grid';

describe('SparseGrid', () => {
  it('stores only bricks with voxels, frees them, and reuses slots', () => {
    const g = new SparseGrid([-5, 0, 0], [100, 40, 20]);
    expect(g.bdims).toEqual([13, 5, 3]);
    g.set(0, 0, 0, 7);
    g.set(99, 39, 19, 9);
    g.set(1, 0, 0, 7);
    expect(g.voxelCount).toBe(3);
    expect(g.bricksUsed).toBe(2);
    expect(g.get(99, 39, 19)).toBe(9);
    expect(g.getWorld(-5, 0, 0)).toBe(7);
    expect(g.get(100, 0, 0)).toBe(0); // outside
    g.set(99, 39, 19, 0);
    expect(g.bricksUsed).toBe(1);
    g.set(50, 20, 10, 3); // reuses the freed slot
    expect(g.slots).toBe(2);
    expect(g.get(50, 20, 10)).toBe(3);
  });

  it('clears boxes, whole bricks and partial ones', () => {
    const g = new SparseGrid([0, 0, 0], [32, 32, 32]);
    for (let z = 0; z < 32; z++) for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if ((x + y + z) % 3 === 0) g.set(x, y, z, 1 + (x % 200));
    const dense = g.toDense();
    const before = g.voxelCount;
    g.clearBox([3, 0, 0], [20, 31, 9]);
    let expected = 0;
    dense.forEach((c, i) => {
      const x = i % 32, y = Math.floor(i / 32) % 32, z = Math.floor(i / 1024);
      const cleared = x >= 3 && x <= 20 && z <= 9;
      if (c && !cleared) expected++;
      expect(g.get(x, y, z)).toBe(cleared ? 0 : c);
    });
    expect(g.voxelCount).toBe(expected);
    expect(before).toBeGreaterThan(expected);
  });

  it('grows its pool', () => {
    const g = new SparseGrid([0, 0, 0], [512, 512, 8]);
    for (let y = 0; y < 512; y += 8) for (let x = 0; x < 512; x += 8) g.set(x, y, 0, 1);
    expect(g.bricksUsed).toBe(64 * 64);
    expect(g.pool.length).toBeGreaterThanOrEqual(4096 * 512);
    expect(g.get(504, 504, 0)).toBe(1);
  });
});
