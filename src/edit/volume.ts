// A model's voxels as a dense array for fast editing, packed back into XYZI form after changes.

import type { VoxModel } from '../vox/types';

export class ModelVolume {
  readonly size: [number, number, number];
  readonly cells: Uint8Array;

  constructor(readonly model: VoxModel) {
    this.size = [...model.size];
    const [sx, sy] = this.size;
    this.cells = new Uint8Array(this.size[0] * this.size[1] * this.size[2]);
    const v = model.voxels;
    for (let i = 0; i < v.length; i += 4) this.cells[v[i] + sx * (v[i + 1] + sy * v[i + 2])] = v[i + 3];
  }

  inside(x: number, y: number, z: number) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.size[0] && y < this.size[1] && z < this.size[2];
  }

  index(x: number, y: number, z: number) {
    return x + this.size[0] * (y + this.size[1] * z);
  }

  get(x: number, y: number, z: number) {
    return this.inside(x, y, z) ? this.cells[this.index(x, y, z)] : 0;
  }

  /** Write the cells back into the model's packed voxel list. */
  pack() {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i]) n++;
    const out = new Uint8Array(n * 4);
    const [sx, sy] = this.size;
    let k = 0;
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      if (!c) continue;
      out[k++] = i % sx;
      out[k++] = Math.floor(i / sx) % sy;
      out[k++] = Math.floor(i / (sx * sy));
      out[k++] = c;
    }
    this.model.voxels = out;
  }
}
