import { describe, expect, it } from 'vitest';
import { runTool } from '../src/assistant/tools';
import { TOOL_DEFS } from '../src/assistant/toolDefs';
import { History } from '../src/edit/history';
import { VoxelEditor } from '../src/edit/editor';
import { SceneBaker } from '../src/vox/scene';
import { emptyScene } from '../src/vox/empty';
import { coreFeatures, createSettings } from '../src/features';
import type { App } from '../src/app';
import { animationLength } from '../src/vox/scene';
import { applyCameraKeys, getKeys, lastKeyFrame } from '../src/anim/camera';

function fakeApp() {
  const file = emptyScene();
  let baker = new SceneBaker(file);
  const history = new History();
  const settings = createSettings(coreFeatures);
  const app = {
    file, fileName: 'test.vox', history, settings,
    get grid() { return baker.grid; },
    animationEnd: () => Math.max(animationLength(file), lastKeyFrame(getKeys(settings)), settings.num('anim.end')),
  } as unknown as App & { editor: VoxelEditor };
  const editor = new VoxelEditor({
    file, get grid() { return baker.grid; }, placements: () => baker.placements, cameraFrame: () => null,
    modelsChanged: (ids) => { if (!baker.refreshModels(ids)) baker = new SceneBaker(file); },
    materialsChanged: () => {}, structureChanged: () => { baker = new SceneBaker(file); }, setStatus: () => {},
  }, history);
  Object.assign(app, { editor });
  settings.onChange((k) => { if (k === 'anim.frame') { baker.setTime(settings.num('anim.frame')); applyCameraKeys(settings); } });
  return app;
}
const json = (o: { content: { type: string; text?: string }[] }) => JSON.parse(o.content[0].text!);

describe('assistant tools', () => {
  it('every tool has a schema and a handler', async () => {
    const app = fakeApp();
    for (const t of TOOL_DEFS) {
      expect(t.inputSchema.type).toBe('object');
      // Unknown tools throw "Unknown tool"; known ones fail on bad input instead (or succeed).
      const err = await runTool(app, t.name, {}).then(() => '', (e: Error) => e.message);
      expect(err).not.toMatch(/Unknown tool/);
    }
  });

  it('builds, animates and undoes as single steps', async () => {
    const app = fakeApp();
    const { model_id, object_id } = json(await runTool(app, 'add_model', { name: 'tower', size: [9, 9, 20], position: [0, 0, 10] }));
    expect(app.history.size).toBe(1);
    const r = await runTool(app, 'draw_shapes', { model_id, shapes: [
      { shape: 'cylinder', center: [4, 4, 0], radius: 4, height: 18, color: 10, hollow: true },
      { shape: 'sphere', center: [4, 4, 18], radius: 3, color: 20, mode: 'add' },
      { shape: 'box', from: [0, 0, 0], to: [8, 8, 0], color: 30 },
    ] });
    expect((r.content[0] as { text: string }).text).toMatch(/Changed \d+ voxels/);
    expect(app.history.size).toBe(2);
    const scene = json(await runTool(app, 'get_scene', {}));
    expect(scene.objects[0]).toMatchObject({ name: 'tower', model_id, object_id });
    expect(scene.palette_in_use.map((p: { index: number }) => p.index).sort()).toEqual([10, 20, 30]);

    await runTool(app, 'set_object_animation', { object_id, keyframes: [{ frame: 0, position: [0, 0, 10] }, { frame: 20, position: [30, 0, 10] }] });
    expect(json(await runTool(app, 'get_scene', {})).animation.last_frame).toBe(20);
    await runTool(app, 'set_settings', { values: { 'cam.yaw': 12, 'nope.key': 1 } });
    expect(app.settings.num('cam.yaw')).toBe(12);
    await runTool(app, 'set_palette', { colors: [{ index: 200, hex: '#ff8800' }, { index: 201, hex: '#000000' }] });
    expect(Array.from(app.file!.palette.subarray(800, 803))).toEqual([255, 136, 0]);
    expect(app.history.size).toBe(5);

    const undone = json(await runTool(app, 'undo', { steps: 5 }));
    expect(undone.undone).toHaveLength(5);
    expect(app.file!.models).toHaveLength(0);
  });

  it('animates the camera', async () => {
    const app = fakeApp();
    await runTool(app, 'add_model', { name: 'm', size: [4, 4, 4], position: [0, 0, 2] });
    const r = json(await runTool(app, 'set_camera_keyframes', { keyframes: [
      { frame: 0, target: [0, 0, 2], yaw: 0, pitch: 20, distance: 50, ease: 'linear' },
      { frame: 120, yaw: 360 },
    ], end_frame: 119 }));
    expect(r).toEqual({ camera_keyframes: 2, timeline_end: 120 });
    app.settings.set('anim.frame', 30);
    expect(app.settings.num('cam.yaw')).toBeCloseTo(90);
    app.settings.set('anim.frame', 90);
    expect(app.settings.num('cam.yaw')).toBeCloseTo(-90); // 270, wrapped
    expect(app.settings.num('cam.pitch')).toBe(20); // carried over
    expect(json(await runTool(app, 'get_scene', {})).camera_keyframes).toHaveLength(2);
    await runTool(app, 'undo', { steps: 2 });
    expect(getKeys(app.settings)).toHaveLength(0);
  });
});
