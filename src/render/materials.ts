// Packs the palette and MATL materials into the GPU material table (256 × 12 floats).

import type { VoxDict } from '../vox/types';

export const MATERIAL_FLOATS = 16;

const TYPES: Record<string, number> = { _diffuse: 0, _metal: 1, _glass: 2, _emit: 3, _blend: 4, _media: 5, _cloud: 5 };

/** MagicaVoxel palettes are sRGB; the path tracer works in linear light. */
export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function num(d: VoxDict | undefined, key: string, fallback: number) {
  if (!d || d[key] === undefined) return fallback;
  const v = Number(d[key]);
  return Number.isFinite(v) ? v : fallback;
}

export function buildMaterialTable(palette: Uint8Array, materials: Map<number, VoxDict>): Float32Array {
  const out = new Float32Array(256 * MATERIAL_FLOATS);
  for (let i = 0; i < 256; i++) {
    const o = i * MATERIAL_FLOATS;
    const m = materials.get(i);
    out[o + 0] = srgbToLinear(palette[i * 4]);
    out[o + 1] = srgbToLinear(palette[i * 4 + 1]);
    out[o + 2] = srgbToLinear(palette[i * 4 + 2]);
    out[o + 3] = palette[i * 4 + 3] / 255;
    const type = TYPES[m?._type ?? '_diffuse'] ?? 0;
    out[o + 4] = type;
    out[o + 5] = num(m, '_rough', 0.1);
    // Older files store metalness in _weight; newer ones use _metal.
    out[o + 6] = type === 1 ? num(m, '_metal', num(m, '_weight', 1)) : num(m, '_metal', 0);
    out[o + 7] = type === 3 ? num(m, '_emit', num(m, '_weight', 1)) : 0;
    // _ri is the real refractive index; _ior stores it minus one.
    out[o + 8] = num(m, '_ri', num(m, '_ior', 0.3) + 1);
    out[o + 9] = num(m, '_flux', 0);
    out[o + 10] = num(m, '_sp', num(m, '_spec', 0.5));
    // How see-through the surface is: glass defaults to clear, blend to opaque.
    // Media (_media/_cloud) are entered every time; blend uses its _trans.
    out[o + 11] = type === 2 ? num(m, '_trans', num(m, '_alpha', 1)) : type === 5 ? 1 : type === 4 ? num(m, '_trans', num(m, '_alpha', 0)) : 0;
    out[o + 12] = num(m, '_d', 0); // density: absorption in glass, scattering in media
    // Scattering medium inside the voxels: media types, or blend with a _media_type (e.g. _sss).
    out[o + 13] = type === 5 || (type === 4 && m?._media_type !== undefined) ? 1 : 0;
    out[o + 14] = num(m, '_g', 0); // phase anisotropy
    out[o + 15] = 0;
  }
  return out;
}
