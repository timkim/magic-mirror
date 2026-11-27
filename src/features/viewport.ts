// File actions in the toolbar: Open .vox, test scenes, Save PNG. (Orbit, pan and zoom live in
// the viewport component itself.)

import type { Feature } from '../core/feature';
import FileButtons from './ui/FileButtons.svelte';

export const viewportFeature: Feature = {
  id: 'files',
  ui: [{ slot: 'toolbar', component: FileButtons, order: 0 }],
};
