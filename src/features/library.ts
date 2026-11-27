// The asset library panel, and dropping assets onto the scene.

import { get } from 'svelte/store';
import type { Feature } from '../core/feature';
import { assets, place } from '../library/library';
import LibraryPanel from './ui/LibraryPanel.svelte';

export const libraryFeature: Feature = {
  id: 'library',
  ui: [{ slot: 'right', component: LibraryPanel, title: 'Library', order: -15 }],
  init(app) {
    app.stageDrops.push((e, u, v, aspect) => {
      const id = e.dataTransfer?.getData('application/x-magic-mirror-asset');
      if (!id) return false;
      const a = get(assets).find((x) => x.id === id);
      if (!a) return true;
      // On the ground, or on top of whatever was under the pointer.
      const hit = app.file ? app.editor.pickAt(u, v, aspect) : null;
      const t = app.settings.vec('cam.target');
      const at: [number, number] = hit ? [hit.cell[0], hit.cell[1]] : [t[0], t[1]];
      const bottom = hit && !hit.ground && hit.normal[2] === 1 ? hit.cell[2] + 1 : undefined;
      place(app, a, at, bottom).catch((err) => app.setStatus('msg', (err as Error).message));
      return true;
    });
  },
};
