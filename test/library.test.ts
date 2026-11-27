import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseVox } from '../src/vox/parser';
import { serializeVox } from '../src/vox/serialize';
import { buildVoxelGrid, SceneBaker } from '../src/vox/scene';
import { writeVox } from '../src/vox/writer';
import { clipFromVox, fileFromClip } from '../src/edit/clipboard';
import { History } from '../src/edit/history';
import { VoxelEditor } from '../src/edit/editor';

const index = JSON.parse(readFileSync('public/library/index.json', 'utf8'));
const asset = (id: string) => parseVox(new Uint8Array(readFileSync(`public/library/${id}.vox`)));

function scene() {
  // A scene that already uses palette slots 1-40 with other colours.
  const pal: Record<number, [number, number, number]> = {};
  for (let i = 1; i <= 40; i++) pal[i] = [i * 3, 200, 100];
  const voxels: [number, number, number, number][] = [];
  for (let i = 1; i <= 40; i++) voxels.push([i % 8, Math.floor(i / 8), 0, i]);
  const file = parseVox(writeVox({ objects: [{ name: 'mine', size: [8, 8, 1], voxels }], palette: pal }));
  let baker = new SceneBaker(file);
  const history = new History();
  const editor = new VoxelEditor({
    file, get grid() { return baker.grid; }, placements: () => baker.placements, cameraFrame: () => null,
    modelsChanged: (ids) => { if (!baker.refreshModels(ids)) baker = new SceneBaker(file); }, materialsChanged: () => {},
    structureChanged: () => { baker = new SceneBaker(file); }, setStatus: () => {},
  }, history);
  return { file, editor, history, baker: () => baker };
}

describe('asset library', () => {
  it('ships valid assets that round-trip', () => {
    expect(index.assets.length).toBeGreaterThanOrEqual(20);
    for (const a of index.assets) {
      const f = asset(a.id);
      expect(buildVoxelGrid(f).voxelCount, a.id).toBe(a.voxels);
      const clip = clipFromVox(f, a.name);
      expect(buildVoxelGrid(fileFromClip(clip)).voxelCount, a.id).toBe(a.voxels);
    }
  });

  it('places with the base on the ground, keeping the asset colours together in free slots', () => {
    const { file, editor, history, baker } = scene();
    const clip = clipFromVox(asset('16_res_house'), 'House');
    const before = baker().grid.voxelCount;
    const id = editor.paste([100, 50], clip)!;
    const p = baker().placements.find((q) => q.nodeId === id)!;
    const m = file.models[p.modelId];
    expect(baker().grid.voxelCount - before).toBe(m.voxels.length / 4);
    // Colours moved to free slots above 40, side by side in their original order.
    const used = [...new Set(Array.from({ length: m.voxels.length / 4 }, (_, i) => m.voxels[i * 4 + 3]))].sort((a, b) => a - b);
    expect(used[0]).toBeGreaterThan(40);
    expect(used.at(-1)! - used[0]).toBe(used.length - 1);
    // And they look the same as in the library.
    const src = asset('16_res_house');
    const orig = [...new Set(Array.from({ length: src.models[0].voxels.length / 4 }, (_, i) => src.models[0].voxels[i * 4 + 3]))].sort((a, b) => a - b);
    orig.forEach((o, k) => expect(Array.from(file.palette.subarray(used[k] * 4, used[k] * 4 + 3))).toEqual(Array.from(src.palette.subarray(o * 4, o * 4 + 3))));
    // Base on the ground (the scene's floor is z = 0 here).
    expect(baker().grid.origin[2]).toBe(0);
    // Saves and reopens.
    expect(buildVoxelGrid(parseVox(serializeVox(file))).voxelCount).toBe(baker().grid.voxelCount);
    history.undo();
    expect(baker().grid.voxelCount).toBe(before);
  });
});
