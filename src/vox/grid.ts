// A sparse voxel grid: the scene's box is split into 8×8×8 bricks, and only bricks with voxels
// in them are stored. `map` holds one entry per brick (0 = empty, else 1 + its slot in `pool`);
// `pool` holds 512 bytes per slot (palette index per voxel, 0 = empty, x fastest).
//
// The GPU gets the same two arrays (map as a 3D r32uint texture, pool as a storage buffer), so
// uploads are copies. A city that's 38 MB as a dense grid is about 3 MB here, and scenes can be
// up to 16,384 voxels on a side (2,048 bricks, the GPU's 3D texture limit).

export const BRICK = 8;
const BRICK_VOXELS = 512;

export class SparseGrid {
  /** World coordinate of cell (0,0,0). */
  readonly origin: [number, number, number];
  readonly dims: [number, number, number];
  /** Bricks per axis. */
  readonly bdims: [number, number, number];
  readonly map: Uint32Array;
  pool: Uint8Array;
  /** Slots in use, including freed ones waiting for reuse (the pool's used length is slots × 512). */
  slots = 0;
  voxelCount = 0;
  /** Voxels per slot, to free a brick when its last voxel goes. */
  private counts: Uint16Array;
  private free: number[] = [];

  constructor(origin: [number, number, number], dims: [number, number, number]) {
    this.origin = origin;
    this.dims = dims;
    this.bdims = dims.map((d) => Math.max(1, Math.ceil(d / BRICK))) as [number, number, number];
    const n = this.bdims[0] * this.bdims[1] * this.bdims[2];
    if (n > 128 * 1024 * 1024) throw new Error(`Scene bounds ${dims.join('×')} are too large (more than 128 million bricks).`);
    this.map = new Uint32Array(n);
    this.pool = new Uint8Array(BRICK_VOXELS * 256);
    this.counts = new Uint16Array(256);
  }

  brickIndex(bx: number, by: number, bz: number) {
    return bx + this.bdims[0] * (by + this.bdims[1] * bz);
  }

  inside(x: number, y: number, z: number) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.dims[0] && y < this.dims[1] && z < this.dims[2];
  }

  /** Palette index at a cell (grid coordinates). 0 = empty or outside. */
  get(x: number, y: number, z: number): number {
    if (!this.inside(x, y, z)) return 0;
    const m = this.map[this.brickIndex(x >> 3, y >> 3, z >> 3)];
    if (m === 0) return 0;
    return this.pool[(m - 1) * BRICK_VOXELS + ((x & 7) | ((y & 7) << 3) | ((z & 7) << 6))];
  }

  /** Same as get(), with world coordinates. */
  getWorld(x: number, y: number, z: number) {
    return this.get(x - this.origin[0], y - this.origin[1], z - this.origin[2]);
  }

  set(x: number, y: number, z: number, c: number) {
    if (!this.inside(x, y, z)) return;
    const bi = this.brickIndex(x >> 3, y >> 3, z >> 3);
    let m = this.map[bi];
    if (m === 0) {
      if (c === 0) return;
      m = this.alloc() + 1;
      this.map[bi] = m;
    }
    const slot = m - 1;
    const i = slot * BRICK_VOXELS + ((x & 7) | ((y & 7) << 3) | ((z & 7) << 6));
    const old = this.pool[i];
    if (old === c) return;
    this.pool[i] = c;
    if (old === 0) { this.voxelCount++; this.counts[slot]++; }
    else if (c === 0) {
      this.voxelCount--;
      if (--this.counts[slot] === 0) {
        this.map[bi] = 0;
        this.free.push(slot);
      }
    }
  }

  /** Empty every cell in an inclusive box (grid coordinates). */
  clearBox(min: [number, number, number], max: [number, number, number]) {
    const lo = min.map((v) => Math.max(0, v)), hi = max.map((v, i) => Math.min(this.dims[i] - 1, v));
    for (let bz = lo[2] >> 3; bz <= hi[2] >> 3; bz++)
      for (let by = lo[1] >> 3; by <= hi[1] >> 3; by++)
        for (let bx = lo[0] >> 3; bx <= hi[0] >> 3; bx++) {
          const bi = this.brickIndex(bx, by, bz);
          const m = this.map[bi];
          if (m === 0) continue;
          const x0 = bx * 8, y0 = by * 8, z0 = bz * 8;
          const whole = x0 >= lo[0] && y0 >= lo[1] && z0 >= lo[2] && x0 + 7 <= hi[0] && y0 + 7 <= hi[1] && z0 + 7 <= hi[2];
          if (whole) {
            // Drop the whole brick at once.
            const slot = m - 1;
            this.voxelCount -= this.counts[slot];
            this.counts[slot] = 0;
            this.pool.fill(0, slot * BRICK_VOXELS, (slot + 1) * BRICK_VOXELS);
            this.map[bi] = 0;
            this.free.push(slot);
            continue;
          }
          for (let z = Math.max(z0, lo[2]); z <= Math.min(z0 + 7, hi[2]); z++)
            for (let y = Math.max(y0, lo[1]); y <= Math.min(y0 + 7, hi[1]); y++)
              for (let x = Math.max(x0, lo[0]); x <= Math.min(x0 + 7, hi[0]); x++) this.set(x, y, z, 0);
        }
  }

  private alloc(): number {
    const reused = this.free.pop();
    if (reused !== undefined) return reused;
    const slot = this.slots++;
    if (this.slots * BRICK_VOXELS > this.pool.length) {
      const pool = new Uint8Array(this.pool.length * 2);
      pool.set(this.pool);
      this.pool = pool;
      const counts = new Uint16Array(this.counts.length * 2);
      counts.set(this.counts);
      this.counts = counts;
    }
    return slot;
  }

  /** Bricks with voxels in them. */
  get bricksUsed() {
    return this.slots - this.free.length;
  }

  /** Call `fn` for every filled voxel (grid coordinates). */
  forEach(fn: (x: number, y: number, z: number, c: number) => void) {
    const [bx, by] = this.bdims;
    for (let bi = 0; bi < this.map.length; bi++) {
      const m = this.map[bi];
      if (m === 0) continue;
      const x0 = (bi % bx) * 8, y0 = (Math.floor(bi / bx) % by) * 8, z0 = Math.floor(bi / (bx * by)) * 8;
      const base = (m - 1) * BRICK_VOXELS;
      for (let i = 0; i < BRICK_VOXELS; i++) {
        const c = this.pool[base + i];
        if (c) fn(x0 + (i & 7), y0 + ((i >> 3) & 7), z0 + (i >> 6), c);
      }
    }
  }

  /** A dense copy (tests and small tools only). */
  toDense(): Uint8Array {
    const [dx, dy] = this.dims;
    const out = new Uint8Array(this.dims[0] * this.dims[1] * this.dims[2]);
    this.forEach((x, y, z, c) => (out[x + dx * (y + dy * z)] = c));
    return out;
  }
}
