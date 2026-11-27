// Undoable edits to camera keyframes and the timeline end (used by the timeline and the assistant).

import type { App } from '../app';
import { getKeys, type CameraKey } from '../anim/camera';

export function setCameraKeys(app: App, keys: CameraKey[], label: string) {
  const s = app.settings;
  const before = s.str('cam.keys');
  const after = JSON.stringify([...keys].sort((a, b) => a.frame - b.frame));
  if (before === after) return;
  app.history.run({ label, apply: () => s.set('cam.keys', after), revert: () => s.set('cam.keys', before) });
}

export function setTimelineEnd(app: App, end: number, label = `Timeline ends at frame ${end}`) {
  const s = app.settings;
  const before = s.num('anim.end');
  end = Math.max(0, Math.round(end));
  if (before === end) return;
  app.history.run({ label, apply: () => s.set('anim.end', end), revert: () => s.set('anim.end', before) });
}

export const keyAt = (app: App, frame: number) => getKeys(app.settings).find((k) => k.frame === frame);
