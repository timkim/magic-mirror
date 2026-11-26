// Scene panel: what's in the open file, including the raw render settings (rOBJ) and
// camera slots (rCAM) MagicaVoxel stored. Useful when mapping more of MagicaVoxel's look.

import type { Feature } from '../core/feature';
import { placeModels, animationLength } from '../vox/scene';

export const sceneInfoFeature: Feature = {
  id: 'sceneInfo',
  init(app) {
    const panel = app.layout.addPanel('left', 'Scene', { order: -1 });
    panel.body.innerHTML = '<p class="mm-muted">No scene loaded.</p>';
    const raw = app.layout.addPanel('left', 'File render settings', { collapsed: true, order: 10 });

    app.on('sceneLoaded', (file, grid, name) => {
      const placed = placeModels(file);
      const len = animationLength(file);
      const rows: [string, string][] = [
        ['File', name],
        ['Version', String(file.version)],
        ['Models', `${file.models.length} (${placed.length} placed)`],
        ['Voxels', grid.voxelCount.toLocaleString()],
        ['Bounds', grid.dims.join(' × ')],
        ['Materials', String(file.materials.size)],
        ['Animation', len ? `${len + 1} frames` : 'static'],
      ];
      if (file.unknownChunks.length) rows.push(['Other chunks', file.unknownChunks.join(', ')]);
      panel.body.innerHTML = '';
      const dl = document.createElement('dl');
      dl.className = 'mm-info';
      for (const [k, v] of rows) {
        const dt = document.createElement('dt'); dt.textContent = k;
        const dd = document.createElement('dd'); dd.textContent = v;
        dl.append(dt, dd);
      }
      panel.body.append(dl);

      const animDef = app.settings.def('anim.frame');
      if (animDef?.type === 'number') animDef.max = Math.max(1, len);

      const pre = document.createElement('pre');
      pre.className = 'mm-raw';
      const cams = file.cameras.filter((c) => Number(c.attrs._radius) > 0 || Number(c.attrs._frustum) > 0);
      pre.textContent = [
        ...file.renderObjects.map((d) => JSON.stringify(d)),
        ...cams.map((c) => `rCAM ${c.id} ${JSON.stringify(c.attrs)}`),
      ].join('\n') || '(none stored)';
      raw.body.innerHTML = '';
      raw.body.append(pre);
    });
  },
};
