// Viewport interaction and file actions: orbit/pan/zoom, Open, sample scenes, Save PNG.

import type { Feature } from '../core/feature';
import { orbitDirection } from '../render/params';

const samples = import.meta.glob('../../test-scenes/*.vox', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

export const viewportFeature: Feature = {
  id: 'viewport',
  init(app) {
    const s = app.settings;
    const { layout } = app;

    // Open file
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.vox';
    input.hidden = true;
    input.addEventListener('change', () => { if (input.files?.[0]) app.openFile(input.files[0]); input.value = ''; });
    layout.addToolbarElement(input);
    layout.addButton('Open .vox', () => input.click(), 'Or drop a .vox file anywhere');

    // Built-in test scenes
    const pick = document.createElement('select');
    pick.append(new Option('Test scenes…', ''));
    for (const [path, url] of Object.entries(samples)) pick.append(new Option(path.split('/').pop()!, url));
    pick.addEventListener('change', async () => {
      if (!pick.value) return;
      const bytes = new Uint8Array(await (await fetch(pick.value)).arrayBuffer());
      app.openVox(bytes, pick.selectedOptions[0].text);
      pick.value = '';
    });
    layout.addToolbarElement(pick);
    layout.addButton('Save PNG', () => app.savePng(), 'Save the current render at full output size');

    // Empty-state hint
    const hint = document.createElement('div');
    hint.className = 'mm-hint';
    hint.textContent = 'Drop a .vox file here, or pick a test scene';
    layout.viewport.append(hint);

    // Orbit (left drag), pan (right drag or Shift), zoom (wheel)
    const stage = layout.stage;
    let drag: { x: number; y: number; pan: boolean } | null = null;
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    stage.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointerup', () => (drag = null));
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) {
        const yaw = s.num('cam.yaw');
        const back = orbitDirection(yaw, s.num('cam.pitch'));
        const right = [-Math.sin((yaw * Math.PI) / 180), Math.cos((yaw * Math.PI) / 180), 0];
        const up = [-back[2] * Math.cos((yaw * Math.PI) / 180), -back[2] * Math.sin((yaw * Math.PI) / 180), Math.hypot(back[0], back[1])];
        const k = (s.num('cam.distance') * Math.tan((s.num('cam.fov') * Math.PI) / 360) * 2) / stage.clientHeight;
        const t = s.vec('cam.target');
        // The scene follows the cursor, so the target moves the opposite way.
        s.set('cam.target', [0, 1, 2].map((i) => t[i] + (-right[i] * dx + up[i] * dy) * k) as [number, number, number]);
      } else {
        let yaw = s.num('cam.yaw') - dx * 0.3;
        if (yaw > 180) yaw -= 360;
        if (yaw < -180) yaw += 360;
        s.set('cam.yaw', yaw);
        s.set('cam.pitch', Math.max(-89, Math.min(89, s.num('cam.pitch') + dy * 0.3)));
      }
    });
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = Math.exp(e.deltaY * 0.001);
      s.set('cam.distance', Math.max(1, s.num('cam.distance') * k));
      s.set('cam.orthoSize', Math.max(1, s.num('cam.orthoSize') * k));
    }, { passive: false });
  },
};
