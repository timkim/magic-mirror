import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { decodeRotation, encodeRotation, parseVox } from '../src/vox/parser';
import { serializeVox } from '../src/vox/serialize';
import { buildVoxelGrid } from '../src/vox/scene';
import { writeVox } from '../src/vox/writer';

describe('serializeVox', () => {
  it('encodes every rotation byte it decodes', () => {
    for (const r of [4, 17, 52, 33, 2, 9, 40, 100, 24]) expect(encodeRotation(decodeRotation(r))).toBe(encodeRotation(decodeRotation(encodeRotation(decodeRotation(r)))));
    for (const r of [4, 17, 52, 33]) expect(encodeRotation(decodeRotation(r))).toBe(r);
  });

  it('round-trips the test scenes byte for byte', () => {
    for (const name of ['01-diffuse', '02-materials', '03-rotations', '04-glass', '05-fog-media']) {
      const bytes = new Uint8Array(readFileSync(`test-scenes/${name}.vox`));
      expect(Buffer.from(serializeVox(parseVox(bytes))).equals(Buffer.from(bytes)), name).toBe(true);
    }
  });

  const big = '/home/claude/vox-in/simcity_v2.vox';
  it.skipIf(!existsSync(big))('round-trips a real MagicaVoxel file byte for byte', () => {
    const bytes = new Uint8Array(readFileSync(big));
    expect(Buffer.from(serializeVox(parseVox(bytes))).equals(Buffer.from(bytes))).toBe(true);
  });

  it('writes edits that read back', () => {
    const file = parseVox(writeVox({ objects: [{ size: [2, 2, 2], voxels: [[0, 0, 0, 3]] }] }));
    file.models[0].voxels = new Uint8Array([0, 0, 0, 3, 1, 1, 1, 9]);
    file.palette.set([1, 2, 3, 255], 9 * 4);
    const again = parseVox(serializeVox(file));
    expect(buildVoxelGrid(again).voxelCount).toBe(2);
    expect(Array.from(again.palette.subarray(36, 40))).toEqual([1, 2, 3, 255]);
  });
});
