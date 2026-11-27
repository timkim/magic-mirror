// Animation timeline strip under the viewport (see ui/Timeline.svelte).

import type { Feature } from '../core/feature';
import Timeline from './ui/Timeline.svelte';

export const timelineFeature: Feature = {
  id: 'timeline',
  ui: [{ slot: 'bottom', component: Timeline }],
};
