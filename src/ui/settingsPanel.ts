// Builds controls for every registered setting group. No per-setting UI code anywhere else.

import type { SettingDef, Settings, SettingValue } from '../core/settings';
import type { Layout } from './layout';

const toHex = (c: [number, number, number]) =>
  '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];

function control(def: SettingDef, settings: Settings): { el: HTMLElement; update: (v: SettingValue) => void } {
  const row = document.createElement('label');
  row.className = 'mm-row';
  if (def.help) row.title = def.help;
  const name = document.createElement('span');
  name.className = 'mm-label';
  name.textContent = def.label;
  row.append(name);

  switch (def.type) {
    case 'number': {
      const range = document.createElement('input');
      range.type = 'range';
      const box = document.createElement('input');
      box.type = 'number';
      for (const i of [range, box]) {
        i.min = String(def.min); i.max = String(def.max); i.step = String(def.step ?? 0.01);
        i.addEventListener('input', () => settings.set(def.key, Number(i.value)));
      }
      row.append(range, box);
      return { el: row, update: (v) => { range.max = box.max = String(def.max); range.value = String(v); box.value = String(Math.round(Number(v) * 1000) / 1000); } };
    }
    case 'bool': {
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.addEventListener('change', () => settings.set(def.key, c.checked));
      row.append(c);
      return { el: row, update: (v) => { c.checked = !!v; } };
    }
    case 'color': {
      const c = document.createElement('input');
      c.type = 'color';
      c.addEventListener('input', () => settings.set(def.key, fromHex(c.value)));
      row.append(c);
      return { el: row, update: (v) => { c.value = toHex(v as [number, number, number]); } };
    }
    case 'select': {
      const s = document.createElement('select');
      for (const o of def.options) s.append(new Option(o.label, o.value));
      s.addEventListener('change', () => settings.set(def.key, s.value));
      row.append(s);
      return {
        el: row,
        update: (v) => {
          // Options can change at runtime (e.g. camera slots from the open file).
          if (s.options.length !== def.options.length || def.options.some((o, i) => s.options[i].value !== o.value)) {
            s.replaceChildren(...def.options.map((o) => new Option(o.label, o.value)));
          }
          s.value = String(v);
        },
      };
    }
    case 'vec3': {
      const wrap = document.createElement('span');
      wrap.className = 'mm-vec3';
      const inputs = [0, 1, 2].map(() => {
        const i = document.createElement('input');
        i.type = 'number';
        i.step = String(def.step ?? 0.1);
        i.addEventListener('input', () => settings.set(def.key, inputs.map((x) => Number(x.value)) as [number, number, number]));
        wrap.append(i);
        return i;
      });
      row.append(wrap);
      return { el: row, update: (v) => (v as number[]).forEach((n, i) => { if (document.activeElement !== inputs[i]) inputs[i].value = String(Math.round(n * 100) / 100); }) };
    }
  }
}

export function buildSettingsPanels(settings: Settings, layout: Layout) {
  const updaters = new Map<string, (v: SettingValue) => void>();
  for (const group of settings.groups) {
    if (group.hidden) continue;
    const panel = layout.addPanel(group.slot ?? 'right', group.label);
    for (const def of group.defs) {
      const c = control(def, settings);
      c.update(settings.get(def.key));
      updaters.set(def.key, c.update);
      panel.body.append(c.el);
    }
  }
  settings.onChange((key, v) => updaters.get(key)?.(v));
}
