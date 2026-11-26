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
    if (sun._disk !== undefined) out['sun.disk'] = sun._disk === '1';
  }
  const sky = renderObject(file, '_uni');
  if (sky) {
    setNum('sky.intensity', sky._i);
    const c = colour(sky._k);
    if (c) out['sky.color'] = c;
  }
  // TODO(match): _env _mode values are inferred: 0 uniform, 1 atmosphere, 2 HDR (a file with
  // _mode 2 also stores an _ibl image path).
  const env = renderObject(file, '_env');
  if (env?._mode !== undefined) out['sky.mode'] = ({ '0': 'uniform', '1': 'atmosphere', '2': 'hdr' } as Record<string, string>)[env._mode] ?? 'atmosphere';
  const atm = renderObject(file, '_atm');
  if (atm) {
    setNum('atm.rayleighDensity', atm._ray_d);
    setNum('atm.mieDensity', atm._mie_d);
    setNum('atm.mieG', atm._mie_g);
    const rk = colour(atm._ray_k), mk = colour(atm._mie_k);
    if (rk) out['atm.rayleighColor'] = rk;
    if (mk) out['atm.mieColor'] = mk;
  }
  const ibl = renderObject(file, '_ibl');
  if (ibl) {
    setNum('hdr.intensity', ibl._i);
    const a = nums(ibl._angle);
    if (a.length) out['hdr.rotation'] = a[0];
  }
  const fog = renderObject(file, '_fog_uni');
  if (fog) {
    setNum('fog.density', fog._d);
    setNum('fog.g', fog._g);
    const c = colour(fog._k);
    if (c) out['fog.color'] = c;
  }
  const bloom = renderObject(file, '_bloom');
  if (bloom) {
    setNum('bloom.mix', bloom._mix);
    setNum('bloom.scale', bloom._scale);
    setNum('bloom.aspect', bloom._aspect);
    setNum('bloom.threshold', bloom._threshold);
  }
  const lens = renderObject(file, '_lens');
  if (lens) {
    setNum('cam.fov', lens._fov);
    // TODO(match): MagicaVoxel's aperture units vs ours.
    setNum('cam.aperture', lens._aperture ?? lens._dof);
  }
  const film = renderObject(file, '_film');
  if (film) {
    // TODO(match): _expo looks like a linear multiplier (1 = neutral); stored here as EV.
    setNum('post.exposure', film._expo, (v) => (v > 0 ? Math.log2(v) : 0));
    setNum('post.vignette', film._vig);
    setNum('post.gamma', film._gam);
    if (film._aces !== undefined) out['post.tonemap'] = film._aces === '1' ? 'aces' : 'none';
  }
  const bounce = renderObject(file, '_bounce');
  if (bounce) {
    const n = Math.max(...nums(`${bounce._diffuse ?? ''} ${bounce._specular ?? ''}`));
    if (Number.isFinite(n)) out['rt.bounces'] = Math.min(32, n);
  }
  const setting = renderObject(file, '_setting');
  if (setting) {
    if (setting._ground !== undefined) out['ground.enabled'] = setting._ground === '1';
    if (setting._bg_c !== undefined) out['bg.mode'] = setting._bg_c === '1' ? 'color' : 'sky';
  }
  const bg = renderObject(file, '_bg');
  if (bg) {
    const c = colour(bg._color);
    if (c) out['bg.color'] = c;
  }
  const ground = renderObject(file, '_ground');
  if (ground) {
    const c = colour(ground._color);
    if (c) out['ground.color'] = c;
    setNum('ground.horizon', ground._hor);
  }

  Object.assign(out, cameraFromSlot(file, 0));
  return out;
}

/** Ids of camera slots the user stored (unused slots have radius 0). */
export function storedCameraSlots(file: VoxFile): number[] {
  return file.cameras.filter((c) => Number(c.attrs._radius) > 0 || Number(c.attrs._frustum) > 0).map((c) => c.id).sort((a, b) => a - b);
}

/** Offset between MagicaVoxel's stored yaw and our orbit yaw. TODO(match): calibrate with a reference. */
export const YAW_OFFSET = -90;
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Camera settings from one of MagicaVoxel's ten camera slots. */
export function cameraFromSlot(file: VoxFile, id: number): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  const cam = file.cameras.find((c) => c.id === id);
  if (!cam || !(Number(cam.attrs._radius) > 0)) return out;
  const focus = nums(cam.attrs._focus);
  const ang = nums(cam.attrs._angle);
  if (focus.length === 3) out['cam.target'] = [focus[0], focus[1], focus[2]];
  // Stored pitch is negative when looking down; ours is positive when the camera is above.
  // Stored yaw is the panel yaw negated (verified). TODO(match): yaw zero direction.
  if (ang.length >= 2) {
    out['cam.pitch'] = Math.max(-89, Math.min(89, -ang[0]));
    out['cam.yaw'] = wrap(ang[1] + YAW_OFFSET);
  }
  const fov = nums(cam.attrs._fov);
  if (fov.length) out['cam.fov'] = fov[0];
  const mode = cam.attrs._mode;
  if (mode === 'orth' || mode === 'iso') {
    out['cam.projection'] = 'orth';
    // Panel zoom = 2 × _frustum; treated as the visible height. TODO(match): verify.
    const fr = nums(cam.attrs._frustum);
    if (fr.length) out['cam.orthoSize'] = fr[0] * 2;
    out['cam.distance'] = 2000;
  } else {
    out['cam.projection'] = 'pers';
    out['cam.distance'] = Number(cam.attrs._radius);
  }
  return out;
}
