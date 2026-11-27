// Camera keyframes. MagicaVoxel files have no camera animation, so Magic Mirror keeps the keys
// in the `cam.keys` setting (JSON), which travels with farm jobs, and saves them in the .vox as
// an extra render-settings entry (rOBJ `_magic_mirror`) that MagicaVoxel ignores.
// Runs headless too: the Node renderer and farm workers use the same functions.

import type { Settings } from '../core/settings';
import type { VoxDict, VoxFile } from '../vox/types';

type V3 = [number, number, number];

export interface CameraKey {
  frame: number;
  target: V3;
  /** Degrees. Not wrapped, so 0 → 360 is one full orbit. */
  yaw: number;
  pitch: number;
  distance: number;
  fov: number;
  orthoSize: number;
  /** How the camera moves from this key to the next: 'smooth' eases in and out (default). */
  ease?: 'smooth' | 'linear';
}

export type CameraPose = Omit<CameraKey, 'frame' | 'ease'>;

export function parseKeys(json: string): CameraKey[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as CameraKey[]).filter((k) => Number.isFinite(k.frame)).sort((a, b) => a.frame - b.frame) : [];
  } catch {
    return [];
  }
}

export const getKeys = (s: Settings) => parseKeys(s.str('cam.keys'));
export const lastKeyFrame = (keys: CameraKey[]) => keys.at(-1)?.frame ?? 0;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Camera at a frame: holds before the first and after the last key, interpolates in between. */
export function cameraAt(keys: CameraKey[], frame: number): CameraPose | null {
  if (keys.length === 0) return null;
  let a = keys[0], b = keys[0];
  if (frame <= keys[0].frame) a = b = keys[0];
  else if (frame >= keys[keys.length - 1].frame) a = b = keys[keys.length - 1];
  else for (let i = 0; i < keys.length - 1; i++) if (frame >= keys[i].frame && frame < keys[i + 1].frame) { a = keys[i]; b = keys[i + 1]; break; }
  let t = a === b ? 0 : (frame - a.frame) / (b.frame - a.frame);
  if ((a.ease ?? 'smooth') === 'smooth') t = t * t * (3 - 2 * t);
  return {
    target: [0, 1, 2].map((i) => lerp(a.target[i], b.target[i], t)) as V3,
    yaw: lerp(a.yaw, b.yaw, t),
    pitch: lerp(a.pitch, b.pitch, t),
    // Zoom feels even when distance changes geometrically.
    distance: Math.exp(lerp(Math.log(Math.max(1e-3, a.distance)), Math.log(Math.max(1e-3, b.distance)), t)),
    fov: lerp(a.fov, b.fov, t),
    orthoSize: Math.exp(lerp(Math.log(Math.max(1e-3, a.orthoSize)), Math.log(Math.max(1e-3, b.orthoSize)), t)),
  };
}

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Put the keyed camera for the current frame into the camera settings. Returns false without keys. */
export function applyCameraKeys(s: Settings): boolean {
  const pose = cameraAt(getKeys(s), s.num('anim.frame'));
  if (!pose) return false;
  s.apply({
    'cam.target': pose.target,
    'cam.yaw': wrap(pose.yaw),
    'cam.pitch': pose.pitch,
    'cam.distance': pose.distance,
    'cam.fov': pose.fov,
    'cam.orthoSize': pose.orthoSize,
  });
  return true;
}

/** The current camera as a key at `frame`. Yaw is unwrapped to stay close to `nearYaw`. */
export function captureKey(s: Settings, frame: number, nearYaw?: number): CameraKey {
  let yaw = s.num('cam.yaw');
  if (nearYaw !== undefined) yaw += Math.round((nearYaw - yaw) / 360) * 360;
  return {
    frame, target: [...s.vec('cam.target')] as V3, yaw, pitch: s.num('cam.pitch'),
    distance: s.num('cam.distance'), fov: s.num('cam.fov'), orthoSize: s.num('cam.orthoSize'),
  };
}

/** Insert or replace the key at its frame. */
export function withKey(keys: CameraKey[], key: CameraKey): CameraKey[] {
  return [...keys.filter((k) => k.frame !== key.frame), key].sort((a, b) => a.frame - b.frame);
}

// ---- Saving in the .vox --------------------------------------------------------------------

const ROBJ = '_magic_mirror';

/** Read keys and the timeline end from the file (empty when it has none). */
export function keysFromVox(file: VoxFile): { keys: string; end: number } {
  const d = file.renderObjects.find((r) => r._type === ROBJ);
  return { keys: d?._cam_keys ?? '[]', end: Number(d?._end ?? 0) || 0 };
}

/** Store keys and the timeline end in the file's render settings (removed when there are none). */
export function keysToVox(file: VoxFile, keys: string, end: number) {
  const i = file.renderObjects.findIndex((r) => r._type === ROBJ);
  const empty = parseKeys(keys).length === 0 && !end;
  if (empty) {
    if (i >= 0) file.renderObjects.splice(i, 1);
    return;
  }
  const d: VoxDict = { _type: ROBJ, _cam_keys: keys, _end: String(end) };
  if (i >= 0) file.renderObjects[i] = d;
  else file.renderObjects.push(d);
}
