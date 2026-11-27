// HDR sky image: load an equirectangular .hdr (button or drag-and-drop) to light the scene.
// When the open .vox names an image (_ibl _path) that isn't loaded, the status bar says so.

import type { Feature } from '../core/feature';
import { renderObject } from '../vox/parser';
import HdrButton from './ui/HdrButton.svelte';

export const environmentFeature: Feature = {
  id: 'environment',
  ui: [{ slot: 'toolbar', component: HdrButton, order: 10 }],
  init(app) {
    const note = () => {
      const loaded = app.environment?.name ?? '';
      const want = app.file ? renderObject(app.file, '_ibl')?._path : undefined;
      if (app.settings.str('sky.mode') === 'hdr' && !loaded)
        app.setStatus('hdr', want ? `Sky image ${want} not loaded: drop it here (using atmosphere)` : 'No HDR loaded (using atmosphere)');
      else app.setStatus('hdr', loaded ? `Sky: ${loaded}` : '');
    };
    app.registerFileHandler({
      accepts: (f) => f.name.toLowerCase().endsWith('.hdr'),
      open: async (f) => {
        app.setStatus('hdr', `Loading ${f.name}…`);
        app.loadEnvironment(new Uint8Array(await f.arrayBuffer()), f.name);
      },
    });
    app.on('sceneLoaded', note);
    app.on('environmentLoaded', note);
    app.settings.onChange((k) => {
      if (k === 'sky.mode') note();
    });
  },
};
