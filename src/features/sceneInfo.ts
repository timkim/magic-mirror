// Scene panels: what's in the open file, and the raw render settings MagicaVoxel stored.

import type { Feature } from '../core/feature';
import { animationLength } from '../vox/scene';
import SceneInfo from './ui/SceneInfo.svelte';
import FileRenderSettings from './ui/FileRenderSettings.svelte';

export const sceneInfoFeature: Feature = {
  id: 'sceneInfo',
  ui: [
    { slot: 'left', title: 'Scene', component: SceneInfo, order: -1 },
    { slot: 'left', title: 'File render settings', component: FileRenderSettings, order: 10, collapsed: true },
  ],
  init(app) {
    // Keep the frame setting's range in step with the open animation.
    app.on('sceneLoaded', (file) => {
      const def = app.settings.def('anim.frame');
      if (def?.type === 'number') def.max = Math.max(1, animationLength(file));
    });
  },
};
