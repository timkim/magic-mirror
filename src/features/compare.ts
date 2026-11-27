// Reference comparison: overlay a MagicaVoxel render on top of ours to match the look.
// Modes: overlay (fade), wipe (split slider) and difference (black = identical).

import { get } from 'svelte/store';
import type { Feature } from '../core/feature';
import { reference } from './compareState';
import ReferenceButton from './ui/ReferenceButton.svelte';
import ReferenceOverlay from './ui/ReferenceOverlay.svelte';

export const compareFeature: Feature = {
  id: 'compare',
  settings: [
    {
      id: 'compare',
      label: 'Reference',
      slot: 'left',
      defs: [
        {
          key: 'compare.mode', label: 'Compare', type: 'select', default: 'wipe', resetsRender: false,
          options: [{ value: 'off', label: 'Off' }, { value: 'overlay', label: 'Overlay' }, { value: 'wipe', label: 'Wipe' }, { value: 'difference', label: 'Difference' }],
        },
        { key: 'compare.amount', label: 'Amount', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, resetsRender: false, help: 'Overlay opacity, or wipe position' },
      ],
    },
  ],
  ui: [
    { slot: 'toolbar', component: ReferenceButton, order: 20 },
    { slot: 'stage', component: ReferenceOverlay },
  ],
  init(app) {
    app.registerFileHandler({
      accepts: (f) => f.type.startsWith('image/'),
      open: (f) => {
        const url = URL.createObjectURL(f);
        const img = new Image();
        img.onload = () => {
          const old = get(reference);
          if (old) URL.revokeObjectURL(old.url);
          reference.set({ url, name: f.name, width: img.naturalWidth, height: img.naturalHeight });
          // Match the render resolution to the reference so pixels line up.
          const preset = `${img.naturalWidth}x${img.naturalHeight}`;
          const def = app.settings.def('out.resolution');
          if (def?.type === 'select' && def.options.some((o) => o.value === preset)) app.settings.set('out.resolution', preset);
          app.setStatus('msg', `Reference: ${f.name} (${img.naturalWidth}×${img.naturalHeight})`);
        };
        img.src = url;
      },
    });
  },
};
