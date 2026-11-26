// Turns setting values into the plain parameter objects the renderer takes.
// This is the one place that knows both the setting keys and the renderer's inputs.

import type { Settings } from '../core/settings';
import type { VoxelGrid } from '../vox/scene';
import type { FrameParams, PostParams, SkyMode, Vec3 } from './renderer';

const rad = (d: number) => (d * Math.PI) / 180;
const norm = (v: Vec3): Vec3 => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];

/** Direction from the target towards the camera (Z up). */
export function orbitDirection(yawDeg: number, pitchDeg: number): Vec3 {
  const y = rad(yawDeg), p = rad(pitchDeg);
  return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p)];
}

export function frameFromSettings(s: Settings, grid: VoxelGrid): FrameParams {
  const target = s.vec('cam.target');
  const dist = s.num('cam.distance');
  const back = orbitDirection(s.num('cam.yaw'), s.num('cam.pitch'));
  const position: Vec3 = [target[0] + back[0] * dist, target[1] + back[1] * dist, target[2] + back[2] * dist];
  const forward = scale(back, -1);
  let right = cross(forward, [0, 0, 1]);
  if (Math.hypot(...right) < 1e-6) right = [1, 0, 0];
  right = norm(right);
  const up = norm(cross(right, forward));
  const ortho = s.str('cam.projection') === 'orth';
  const focus = s.num('cam.focus');

  const sunDir = orbitDirection(s.num('sun.yaw'), s.num('sun.pitch'));
  const bgMode = s.str('bg.mode');

  return {
    camera: {
      position,
      forward,
      right,
      up,
      scale: ortho ? s.num('cam.orthoSize') / 2 : Math.tan(rad(s.num('cam.fov')) / 2),
      orthographic: ortho,
      aperture: s.num('cam.aperture'),
      focusDistance: focus > 0 ? focus : dist,
    },
    lighting: {
      sunDirection: sunDir,
      sunCosRadius: Math.cos(rad(Math.max(0.01, s.num('sun.size')) / 2)),
      sunColor: scale(s.vec('sun.color'), s.num('sun.intensity') * Math.PI),
      sunEnabled: s.bool('sun.enabled'),
      sunDisk: s.bool('sun.disk'),
      skyMode: s.str('sky.mode') as SkyMode,
      skyColor: scale(s.vec('sky.color'), s.num('sky.intensity')),
      rayleigh: scale(s.vec('atm.rayleighColor'), s.num('atm.rayleighDensity')),
      mieColor: s.vec('atm.mieColor'),
      mieDensity: s.num('atm.mieDensity'),
      mieG: s.num('atm.mieG'),
      atmosphereIntensity: s.num('atm.intensity'),
      hdrIntensity: s.num('hdr.intensity'),
      hdrRotation: rad(s.num('hdr.rotation')),
      horizonFade: s.num('ground.horizon'),
      background: bgMode === 'color' ? s.vec('bg.color') : null,
      ground: s.bool('ground.enabled') ? s.vec('ground.color') : null,
      groundHeight: grid.origin[2],
    },
    maxBounces: s.num('rt.bounces'),
  };
}

export function postFromSettings(s: Settings): PostParams {
  return {
    exposure: Math.pow(2, s.num('post.exposure')),
    tonemap: s.str('post.tonemap') as PostParams['tonemap'],
    gamma: s.num('post.gamma'),
    vignette: s.num('post.vignette'),
    bloomMix: s.num('bloom.mix'),
    bloomScale: s.num('bloom.scale'),
    bloomAspect: s.num('bloom.aspect'),
    bloomThreshold: s.num('bloom.threshold'),
  };
}

/** Output size for the chosen resolution preset; `viewport` uses the given fallback size. */
export function outputSize(s: Settings, viewport: [number, number]): [number, number] {
  const preset = s.str('out.resolution');
  const m = /^(\d+)x(\d+)$/.exec(preset);
  const base: [number, number] = m ? [Number(m[1]), Number(m[2])] : viewport;
  const k = s.num('out.previewScale');
  return [Math.max(1, Math.round(base[0] * k)), Math.max(1, Math.round(base[1] * k))];
}

/** Place the camera so the whole grid is in view. */
export function frameScene(grid: VoxelGrid, fovDeg: number) {
  const c: Vec3 = [0, 1, 2].map((i) => grid.origin[i] + grid.dims[i] / 2) as Vec3;
  const r = Math.hypot(...grid.dims) / 2;
  return { target: c, distance: Math.max(4, (r / Math.sin(rad(fovDeg) / 2)) * 0.8) };
}
