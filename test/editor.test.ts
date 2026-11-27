import { describe, expect, it } from 'vitest';
import { parseVox } from '../src/vox/parser';
import { SceneBaker, buildVoxelGrid } from '../src/vox/scene';
import { writeVox } from '../src/vox/writer';
import { serializeVox } from '../src/vox/serialize';
import { History } from '../src/edit/history';
import { VoxelEditor, type EditorHost } from '../src/edit/editor';
import { castRay } from '../src/edit/pick';
import { emptyScene } from '../src/vox/empty';

function setup() {
  const file = parseVox(writeVox({ objects: [{ name: 'box', size: [4, 4, 4], voxels: [[0, 0, 0, 3], [3, 3, 3, 3]], translation: [10, 0, 2], rotation: 17 }] }));
  let baker = new SceneBaker(file);
  const host: EditorHost = {
    file,
    get grid() { return baker.grid; },
    placements: () => baker.placements,
    cameraFrame: () => null,
    modelsChanged: (ids) => { if (!baker.refreshModels(ids)) baker = new SceneBaker(file); },
    materialsChanged: () => {},
    structureChanged: () => { baker = new SceneBaker(file); },
    setStatus: () => {},
  };
  const history = new History();
  return { file, host, history, editor: new VoxelEditor(host, history), baker: () => baker };
}

describe('VoxelEditor', () => {
  it('edits a model, keeps the grid in step, and undoes', () => {
    const { file, history, editor, baker } = setup();
    expect(editor.setVoxels(0, [[1, 1, 1, 9], [2, 2, 2, 9], [0, 0, 0, 0]], 'test')).toBe(3);
    const full = buildVoxelGrid(file);
    expect(baker().grid.voxelCount).toBe(3);
    expect(Array.from(baker().grid.cells).filter(Boolean).length).toBe(full.voxelCount);
    history.undo();
    expect(baker().grid.voxelCount).toBe(2);
    history.redo();
    expect(parseVox(serializeVox(file)).models[0].voxels.length / 4).toBe(3);
  });

  it('finds the owning model of a voxel through its rotation', () => {
    const { editor, baker } = setup();
    const g = baker().grid;
    const i = g.cells.findIndex(Boolean);
    const cx = (i % g.dims[0]) + g.origin[0], cy = Math.floor(i / g.dims[0]) % g.dims[1] + g.origin[1];
    const hit = castRay(g, [cx + 0.5, cy + 0.5, 100], [0, 0, -1]);
    expect(hit && !hit.ground).toBe(true);
    expect(editor.ownerOf(hit!.cell)?.modelId).toBe(0);
  });

  it('adds a model to an empty scene and undoes it', () => {
    const file = emptyScene();
    let baker = new SceneBaker(file);
    const history = new History();
    const ed = new VoxelEditor({ file, get grid() { return baker.grid; }, placements: () => baker.placements, cameraFrame: () => null, modelsChanged: (ids) => { if (!baker.refreshModels(ids)) baker = new SceneBaker(file); }, materialsChanged: () => {}, structureChanged: () => { baker = new SceneBaker(file); }, setStatus: () => {} }, history);
    const id = ed.addModel([8, 8, 8], [0, 0, 4], 'tower');
    ed.setVoxels(id, [[0, 0, 0, 5], [7, 7, 7, 5]]);
    expect(baker.grid.voxelCount).toBe(2);
    const again = parseVox(serializeVox(file));
    expect(buildVoxelGrid(again).voxelCount).toBe(2);
    history.undo();
    history.undo();
    expect(baker.placements.length).toBe(0);
  });

  it('moves, rotates and resizes objects in place, and edits layers', () => {
    const { file, history, editor, baker } = setup();
    const node = baker().placements[0].nodeId!;
    const world = () => { const g = baker().grid, out: string[] = []; g.cells.forEach((c, i) => { if (c) out.push([i % g.dims[0] + g.origin[0], Math.floor(i / g.dims[0]) % g.dims[1] + g.origin[1], Math.floor(i / (g.dims[0] * g.dims[1])) + g.origin[2]].join(',')); }); return out.sort(); };
    const before = world();

    editor.moveObject(node, [3, -2, 1]);
    expect(world()).toEqual(before.map((p) => { const [x, y, z] = p.split(',').map(Number); return [x + 3, y - 2, z + 1].join(','); }).sort());
    history.undo();
    expect(world()).toEqual(before);

    // Growing the box (and shifting voxels inside it) must not move anything in the world.
    const r = editor.resizeModel(0, [7, 6, 9], [2, 1, 3]);
    expect(r.cut).toBe(0);
    expect(world()).toEqual(before);
    // Shrinking cuts voxels outside the box, but keeps the rest in place.
    history.undo();
    const cut = editor.resizeModel(0, [2, 2, 2]);
    expect(cut.cut).toBe(1);
    expect(before).toEqual(expect.arrayContaining(world()));
    history.undo();

    editor.rotateObject(node, 2);
    expect(world()).not.toEqual(before);
    editor.rotateObject(node, 2);
    expect(world()).toEqual(before);

    editor.setObject(node, { hidden: true });
    expect(baker().placements.length).toBe(0);
    history.undo();
    editor.setLayer(0, { name: 'Buildings', hidden: true });
    expect(baker().placements.length).toBe(0);
    const again = parseVox(serializeVox(file));
    expect(again.layers.get(0)?.attrs._name).toBe('Buildings');
    expect(again.layers.get(0)?.hidden).toBe(true);
    history.undo();
    expect(baker().placements.length).toBe(1);
  });
});
