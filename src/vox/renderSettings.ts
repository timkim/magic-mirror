// Reads MagicaVoxel's stored render settings (rOBJ) and camera slots (rCAM) into
// Magic Mirror setting values, so a scene opens looking the way it was set up.
//
// TODO(match): these key names come from inspecting MagicaVoxel 0.99.x files and the
// community docs. Check every mapping against real files; the Scene panel lists the raw
// rOBJ dictionaries of the open file to make that easy.

import type { SettingValue } from '../core/settings';
import type { VoxFile } from './types';
import { renderObject } from './parser';

function nums(s: string | undefined): number[] {
  if (s === undefined) return [];
  return s.trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
}

/** Colour stored as "r g b" (0-255 or 0-1) → 0-1 floats. */
function colour(s: string | undefined): [number, number, number] | undefined {
  const n = nums(s);
  if (n.length < 3) return undefined;
  const scale = n.some((v) => v > 1) ? 1 / 255 : 1;
  return [n[0] * scale, n[1] * scale, n[2] * scale];
}

export function settingsFromVox(file: VoxFile): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  const setNum = (key: string, s: string | undefined, f = (v: number) => v) => {
    const n = nums(s);
    if (n.length) out[key] = f(n[0]);
  };

  const sun = renderObject(file, '_inf');
  if (sun) {
    setNum('sun.intensity', sun._i);
    const c = colour(sun._k);
    if (c) out['sun.color'] = c;
    const a = nums(sun._angle);
    if (a.length >= 2) { out['sun.pitch'] = a[0]; out['sun.yaw'] = a[1]; }
    setNum('sun.size', sun._area, (v) => v * 30); // _area is 0-1 in the UI
    if (sun._disk !== undefined) out['sun.enabled'] = true;
  }
  const sky = renderObject(file, '_uni');
  if (sky) {
    setNum('sky.intensity', sky._i);
    const c = colour(sky._k);
    if (c) out['sky.color'] = c;
  }
  const lens = renderObject(file, '_lens');
  if (lens) {
    setNum('cam.fov', lens._fov);
    setNum('cam.aperture', lens._dof);
    setNum('post.exposure', lens._expo);
    setNum('post.vignette', lens._vig);
  }
  const bg = renderObject(file, '_bg');
  if (bg) {
    const c = colour(bg._color);
    if (c) { out['bg.color'] = c; out['bg.mode'] = 'color'; }
  }
  const ground = renderObject(file, '_ground');
  if (ground) {
    const c = colour(ground._color);
    if (c) out['ground.color'] = c;
  }

  // Camera slot 0, if the user stored one (unused slots have radius 0).
  const cam = file.cameras.find((c) => c.id === 0 && Number(c.attrs._radius) > 0);
  if (cam) {
    const focus = nums(cam.attrs._focus);
    const ang = nums(cam.attrs._angle);
    if (focus.length === 3) out['cam.target'] = [focus[0], focus[1], focus[2]];
    // File yaw is the panel yaw with the sign flipped (verified). TODO(match): check pitch sign and
    // the zero direction of yaw against a reference render.
    if (ang.length >= 2) { out['cam.pitch'] = ang[0]; out['cam.yaw'] = -ang[1]; }
    setNum('cam.distance', cam.attrs._radius);
    setNum('cam.fov', cam.attrs._fov);
    if (cam.attrs._mode === 'orth') {
      out['cam.projection'] = 'orth';
      setNum('cam.orthoSize', cam.attrs._frustum);
    }
  }
  return out;
}
