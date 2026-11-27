// The voxel editor feature: toolbar (edit mode, undo/redo, new scene, save .vox), the Edit
// panel (mode, brush, mirror, model), the palette and material panel, and the outlines drawn
// over the render. The editing itself lives in src/edit/editor.ts.

import { get } from 'svelte/store';
import type { Feature } from '../core/feature';
import EditToolbar from './ui/EditToolbar.svelte';
import EditPanel from './ui/EditPanel.svelte';
import PalettePanel from './ui/PalettePanel.svelte';
import EditOverlay from './ui/EditOverlay.svelte';

export const editorFeature: Feature = {
  id: 'editor',
  ui: [
    { slot: 'toolbar', component: EditToolbar, order: 5 },
    { slot: 'left', component: EditPanel, title: 'Edit', order: -10 },
    { slot: 'right', component: PalettePanel, title: 'Palette', order: -10 },
    { slot: 'stage', component: EditOverlay },
  ],
  init(app) {
    const ed = app.editor;
    app.viewportTools.push({
      active: () => get(ed.enabled) && !!app.file,
      pointerDown: (u, v, a, e) => ed.pointerDown(u, v, a, e),
      pointerMove: (u, v, a) => ed.pointerMove(u, v, a),
      pointerUp: () => ed.pointerUp(),
      leave: () => ed.leave(),
    });
    ed.enabled.subscribe((on) => {
      app.viewportCursor.set(on ? 'crosshair' : null);
      if (!on) ed.preview.set({ boxes: [] });
    });
  },
};
