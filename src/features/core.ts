// Core render features: camera, lighting, output and post-processing settings.
// Defaults approximate a fresh MagicaVoxel scene. TODO(match): tune against references.

import type { Feature } from '../core/feature';
import { cameraFromSlot, settingsFromVox, storedCameraSlots } from '../vox/renderSettings';
import type { Settings } from '../core/settings';
import type { VoxFile } from '../vox/types';
import type { VoxelGrid } from '../vox/scene';
import { frameScene } from '../render/params';
import { applyCameraKeys, keysFromVox } from '../anim/camera';

const scenes = new WeakMap<Settings, { file: VoxFile; grid: VoxelGrid }>();
const watched = new WeakSet<Settings>();

function applySlot(settings: Settings, slot: string) {
  const sc = scenes.get(settings);
  if (!sc) return;
  if (slot === 'auto') {
    const f = frameScene(sc.grid, settings.num('cam.fov'));
    settings.apply({ 'cam.projection': 'pers', 'cam.target': f.target, 'cam.distance': f.distance, 'cam.orthoSize': f.distance * 0.8, 'cam.yaw': -135, 'cam.pitch': 30 });
  } else settings.apply(cameraFromSlot(sc.file, Number(slot)));
}

export const cameraFeature: Feature = {
  id: 'camera',
  settings: [
    {
      id: 'camera',
      label: 'Camera',
      defs: [
        { key: 'cam.slot', label: 'File camera', type: 'select', default: 'auto', options: [{ value: 'auto', label: 'Auto frame' }], help: "MagicaVoxel's stored camera slots (0-9)" },
        { key: 'cam.projection', label: 'Projection', type: 'select', default: 'pers', options: [{ value: 'pers', label: 'Perspective' }, { value: 'orth', label: 'Orthographic' }] },
        { key: 'cam.target', label: 'Target', type: 'vec3', default: [0, 0, 0], step: 1 },
        { key: 'cam.yaw', label: 'Yaw', type: 'number', default: -135, min: -180, max: 180, step: 0.5 },
        { key: 'cam.pitch', label: 'Pitch', type: 'number', default: 30, min: -89, max: 89, step: 0.5 },
        { key: 'cam.distance', label: 'Distance', type: 'number', default: 100, min: 1, max: 5000, step: 1 },
        { key: 'cam.fov', label: 'Field of view', type: 'number', default: 45, min: 5, max: 120, step: 0.5, help: 'Vertical, degrees (MagicaVoxel default 45°)' },
        { key: 'cam.orthoSize', label: 'Ortho height', type: 'number', default: 100, min: 1, max: 5000, step: 1 },
        { key: 'cam.aperture', label: 'Aperture (DOF)', type: 'number', default: 0, min: 0, max: 10, step: 0.05 },
        { key: 'cam.focus', label: 'Focus distance', type: 'number', default: 0, min: 0, max: 5000, step: 1, help: '0 = focus on the target' },
      ],
    },
  ],
  onSceneLoaded(file, grid, settings) {
    scenes.set(settings, { file, grid });
    const slots = storedCameraSlots(file).filter((id) => Number(file.cameras.find((c) => c.id === id)?.attrs._radius) > 1);
    const def = settings.def('cam.slot');
    if (def?.type === 'select') def.options = [{ value: 'auto', label: 'Auto frame' }, ...slots.map((id) => ({ value: String(id), label: `Slot ${id}` }))];
    if (!watched.has(settings)) {
      watched.add(settings);
      settings.onChange((k, v) => { if (k === 'cam.slot') applySlot(settings, String(v)); });
    }
    const wanted = settings.str('cam.slot');
    settings.set('cam.slot', wanted !== 'auto' && slots.includes(Number(wanted)) ? wanted : 'auto');
    // Camera keyframes saved by Magic Mirror.
    const saved = keysFromVox(file);
    settings.set('anim.end', saved.end);
    settings.set('cam.keys', saved.keys);
    applyCameraKeys(settings);
  },
};

export const lightingFeature: Feature = {
  id: 'lighting',
  settings: [
    {
      id: 'sun',
      label: 'Sun',
      defs: [
        { key: 'sun.enabled', label: 'Sun', type: 'bool', default: true },
        { key: 'sun.intensity', label: 'Sun intensity', type: 'number', default: 0.7, min: 0, max: 10, step: 0.01 },
        { key: 'sun.color', label: 'Sun colour', type: 'color', default: [1, 1, 1] },
        { key: 'sun.yaw', label: 'Sun yaw', type: 'number', default: 50, min: -180, max: 180, step: 0.5 },
        { key: 'sun.pitch', label: 'Sun pitch', type: 'number', default: 50, min: -90, max: 90, step: 0.5 },
        { key: 'sun.size', label: 'Sun size', type: 'number', default: 3, min: 0, max: 30, step: 0.1, help: 'Angular diameter in degrees; larger = softer shadows' },
        { key: 'sun.disk', label: 'Sun disk', type: 'bool', default: false, help: 'Show the sun in the sky' },
      ],
    },
    {
      id: 'sky',
      label: 'Sky',
      defs: [
        {
          key: 'sky.mode', label: 'Sky', type: 'select', default: 'atmosphere',
          options: [{ value: 'uniform', label: 'Uniform colour' }, { value: 'atmosphere', label: 'Atmosphere' }, { value: 'hdr', label: 'HDR image' }],
          help: 'HDR image falls back to Atmosphere until an .hdr file is loaded',
        },
        { key: 'sky.intensity', label: 'Sky intensity', type: 'number', default: 0.6, min: 0, max: 10, step: 0.01 },
        { key: 'sky.color', label: 'Sky colour', type: 'color', default: [1, 1, 1] },
        { key: 'atm.intensity', label: 'Atmosphere brightness', type: 'number', default: 1, min: 0, max: 10, step: 0.01 },
        { key: 'atm.rayleighDensity', label: 'Rayleigh density', type: 'number', default: 0.2, min: 0, max: 2, step: 0.01 },
        { key: 'atm.rayleighColor', label: 'Rayleigh colour', type: 'color', default: [0.24, 0.45, 1] },
        { key: 'atm.mieDensity', label: 'Mie (haze) density', type: 'number', default: 0.3, min: 0, max: 2, step: 0.01 },
        { key: 'atm.mieColor', label: 'Mie colour', type: 'color', default: [1, 1, 1] },
        { key: 'atm.mieG', label: 'Mie glow size', type: 'number', default: 0.8, min: 0, max: 0.99, step: 0.01, help: 'Anisotropy: higher = tighter glow around the sun' },
        { key: 'hdr.intensity', label: 'HDR intensity', type: 'number', default: 1, min: 0, max: 10, step: 0.01 },
        { key: 'hdr.rotation', label: 'HDR rotation', type: 'number', default: 0, min: -180, max: 180, step: 0.5 },
      ],
    },
    {
      id: 'ground',
      label: 'Background, ground & fog',
      defs: [
        { key: 'bg.mode', label: 'Background', type: 'select', default: 'color', options: [{ value: 'sky', label: 'Sky' }, { value: 'color', label: 'Colour' }] },
        { key: 'bg.color', label: 'Background colour', type: 'color', default: [0.55, 0.55, 0.55] },
        { key: 'ground.enabled', label: 'Ground', type: 'bool', default: true },
        { key: 'ground.color', label: 'Ground colour', type: 'color', default: [0.8, 0.8, 0.8] },
        { key: 'fog.density', label: 'Fog density', type: 'number', default: 0, min: 0, max: 1, step: 0.005 },
        { key: 'fog.color', label: 'Fog colour', type: 'color', default: [1, 1, 1] },
        { key: 'fog.g', label: 'Fog glow', type: 'number', default: 0, min: -0.9, max: 0.9, step: 0.01, help: 'Positive values scatter light forwards (glow around the sun)' },
        { key: 'ground.horizon', label: 'Horizon fade', type: 'number', default: 0, min: 0, max: 1, step: 0.01, help: 'Fade the ground into the background with distance' },
      ],
    },
  ],
  onSceneLoaded(file, _grid, settings) {
    const fromFile = settingsFromVox(file);
    for (const k of Object.keys(fromFile)) if (/^(sun|sky|bg|ground|atm|hdr|fog)\./.test(k)) settings.set(k, fromFile[k]);
  },
};

export const outputFeature: Feature = {
  id: 'output',
  settings: [
    {
      id: 'output',
      label: 'Render',
      defs: [
        {
          key: 'out.resolution',
          label: 'Resolution',
          type: 'select',
          default: '1080x1920',
          options: [
            { value: '1080x1920', label: '1080 × 1920 (portrait)' },
            { value: '1920x1080', label: '1920 × 1080' },
            { value: '1080x1080', label: '1080 × 1080' },
            { value: 'viewport', label: 'Fit viewport' },
          ],
        },
        { key: 'out.previewScale', label: 'Preview scale', type: 'number', default: 0.5, min: 0.1, max: 1, step: 0.05, help: 'Render at a fraction of the resolution while working; use 1 for final frames' },
        { key: 'rt.bounces', label: 'Bounces', type: 'number', default: 6, min: 1, max: 32, step: 1 },
        { key: 'rt.samplesPerFrame', label: 'Samples per frame', type: 'number', default: 2, min: 1, max: 32, step: 1, resetsRender: false },
        { key: 'rt.maxSamples', label: 'Stop after samples', type: 'number', default: 1024, min: 1, max: 65536, step: 1, resetsRender: false },
      ],
    },
    {
      id: 'animation',
      label: 'Animation',
      hidden: true, // edited through the timeline strip
      defs: [
        { key: 'anim.frame', label: 'Frame', type: 'number', default: 0, min: 0, max: 1000, step: 1 },
        { key: 'anim.fps', label: 'FPS', type: 'number', default: 12, min: 1, max: 60, step: 1, resetsRender: false },
        { key: 'anim.playSamples', label: 'Samples while playing', type: 'number', default: 4, min: 1, max: 4096, step: 1, resetsRender: false },
        { key: 'anim.loop', label: 'Loop', type: 'bool', default: true, resetsRender: false },
        { key: 'anim.exportSamples', label: 'Samples per exported frame', type: 'number', default: 256, min: 1, max: 65536, step: 1, resetsRender: false },
        { key: 'anim.end', label: 'Timeline end', type: 'number', default: 0, min: 0, max: 10000, step: 1, resetsRender: false, help: 'Last frame, when it should go past the scene\'s own keyframes' },
        { key: 'cam.keys', label: 'Camera keyframes', type: 'text', default: '[]', help: 'JSON list of camera keys (see src/anim/camera.ts)' },
      ],
    },
    {
      id: 'post',
      label: 'Image',
      defs: [
        { key: 'post.exposure', label: 'Exposure (EV)', type: 'number', default: 0, min: -6, max: 6, step: 0.05, resetsRender: false },
        { key: 'post.tonemap', label: 'Tone mapping', type: 'select', default: 'aces', resetsRender: false, options: [{ value: 'aces', label: 'ACES' }, { value: 'reinhard', label: 'Reinhard' }, { value: 'none', label: 'None (clip)' }] },
        { key: 'post.gamma', label: 'Gamma', type: 'number', default: 2.2, min: 1, max: 3, step: 0.01, resetsRender: false },
        { key: 'post.vignette', label: 'Vignette', type: 'number', default: 0, min: 0, max: 1, step: 0.01, resetsRender: false },
        { key: 'bloom.mix', label: 'Bloom', type: 'number', default: 0, min: 0, max: 1, step: 0.01, resetsRender: false },
        { key: 'bloom.scale', label: 'Bloom size', type: 'number', default: 0.4, min: 0, max: 1, step: 0.01, resetsRender: false },
        { key: 'bloom.aspect', label: 'Bloom stretch', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, resetsRender: false, help: '0.5 = round, higher = wider' },
        { key: 'bloom.threshold', label: 'Bloom threshold', type: 'number', default: 0, min: 0, max: 4, step: 0.01, resetsRender: false },
      ],
    },
  ],
  onSceneLoaded(file, _grid, settings) {
    const fromFile = settingsFromVox(file);
    for (const k of Object.keys(fromFile)) if (/^(post|rt|bloom)\./.test(k)) settings.set(k, fromFile[k]);
  },
};
