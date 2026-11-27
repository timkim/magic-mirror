// Magic Prism farm panel (see ui/FarmPanel.svelte and farmClient.ts).

import type { Feature } from '../core/feature';
import FarmPanel from './ui/FarmPanel.svelte';

export const farmFeature: Feature = {
  id: 'farm',
  ui: [{ slot: 'left', title: 'Magic Prism farm', component: FarmPanel, order: 5, collapsed: true }],
};
