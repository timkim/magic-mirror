// HDR sky image: load an equirectangular .hdr (button or drag-and-drop) to light the scene.
// When the open .vox names an image (_ibl _path) that isn't loaded, the status bar says so.

import type { Feature } from '../core/feature';
import { loadHdrEnvironment } from '../render/hdr';
import { renderObject } from '../vox/parser';

export const environmentFeature: Feature = {
  id: 'environment',
  init(app) {
    let loadedName = '';
    const note = () => {
      const want = app.file ? renderObject(app.file, '_ibl')?._path : undefined;
      if (app.settings.str('sky.mode') === 'hdr' && !loadedName)
        app.layout.setStatus('hdr', want ? `Sky image ${want} not loaded: drop it here (using atmosphere)` : 'No HDR loaded (using atmosphere)');
      else app.layout.setStatus('hdr', loadedName ? `Sky: ${loadedName}` : '');
    };

    const open = async (f: File) => {
      app.layout.setStatus('hdr', `Loading ${f.name}…`);
      const env = loadHdrEnvironment(new Uint8Array(await f.arrayBuffer()));
      app.renderer.setEnvironment(env);
      loadedName = f.name;
      app.settings.set('sky.mode', 'hdr');
      app.restart();
      note();
    };
    app.registerFileHandler({ accepts: (f) => f.name.toLowerCase().endsWith('.hdr'), open });

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.hdr';
    input.hidden = true;
    input.addEventListener('change', () => { if (input.files?.[0]) app.openFile(input.files[0]); input.value = ''; });
    app.layout.addToolbarElement(input);
    app.layout.addButton('HDR sky…', () => input.click(), 'Load an equirectangular .hdr image to light the scene');

    app.on('sceneLoaded', note);
    app.settings.onChange((k) => { if (k === 'sky.mode') note(); });
  },
};
