// Reference comparison: overlay a MagicaVoxel render on top of ours to match the look.
// Modes: overlay (fade), wipe (split slider) and difference (black = identical).

import type { Feature } from '../core/feature';

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
  init(app) {
    const s = app.settings;
    const img = document.createElement('img');
    img.className = 'mm-reference';
    img.hidden = true;
    app.layout.stage.append(img);

    const update = () => {
      const mode = s.str('compare.mode');
      const amt = s.num('compare.amount');
      img.hidden = !img.src || mode === 'off';
      img.style.opacity = mode === 'overlay' ? String(amt) : '1';
      img.style.mixBlendMode = mode === 'difference' ? 'difference' : 'normal';
      img.style.clipPath = mode === 'wipe' ? `inset(0 0 0 ${amt * 100}%)` : 'none';
    };
    s.onChange((k) => { if (k.startsWith('compare.')) update(); });

    const load = (f: File) => {
      if (img.src) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(f);
      img.onload = () => {
        // Match the render resolution to the reference so pixels line up.
        const preset = `${img.naturalWidth}x${img.naturalHeight}`;
        const def = s.def('out.resolution');
        if (def?.type === 'select' && def.options.some((o) => o.value === preset)) s.set('out.resolution', preset);
        app.layout.setStatus('msg', `Reference: ${f.name} (${img.naturalWidth}×${img.naturalHeight})`);
        update();
      };
    };
    app.registerFileHandler({ accepts: (f) => f.type.startsWith('image/'), open: load });

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    input.addEventListener('change', () => { if (input.files?.[0]) load(input.files[0]); input.value = ''; });
    app.layout.addToolbarElement(input);
    app.layout.addButton('Reference…', () => input.click(), 'Load a MagicaVoxel render to compare against (or drop an image)');
  },
};
