// Builds the starter asset library: SimCity-style pieces on a 16-voxel tile grid, matching
// the scale of simcity_v2 (16/32/64 lots, 2×4×2 cars, 5×5×7 trees). Each asset is a normal
// .vox file (MagicaVoxel opens them) in public/library/, listed in public/library/index.json.
//
//   npx tsx tools/make-library.ts
//
// All assets share one palette, laid out in blocks so colours stay easy to find and change:
//   1-16 terrain · 17-32 roads · 33-80 buildings · 81-112 props

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeVox } from '../src/vox/writer';
import type { VoxDict } from '../src/vox/types';

type RGB = [number, number, number];
const P: Record<string, [number, RGB]> = {
  // Terrain 1-16
  grass: [1, [106, 168, 79]], grass2: [2, [92, 152, 68]], grass3: [3, [122, 180, 92]], grassDark: [4, [70, 124, 56]],
  dirt: [5, [139, 104, 70]], dirt2: [6, [120, 88, 60]], sand: [7, [226, 206, 150]], sand2: [8, [212, 190, 132]],
  waterDeep: [9, [44, 106, 164]], water: [10, [64, 140, 196]], foam: [11, [190, 224, 240]], rock: [12, [128, 126, 120]], rock2: [13, [106, 104, 100]],
  // Roads 17-32
  asphalt: [17, [62, 64, 70]], asphalt2: [18, [74, 76, 82]], laneWhite: [19, [236, 236, 230]], laneYellow: [20, [240, 196, 60]],
  curb: [21, [168, 168, 164]], sidewalk: [22, [196, 194, 186]], sidewalk2: [23, [182, 180, 172]],
  // Buildings 33-80
  brick: [33, [168, 84, 64]], brick2: [34, [150, 72, 56]], beige: [35, [222, 204, 168]], beige2: [36, [206, 186, 150]],
  white: [37, [236, 234, 228]], gray: [38, [150, 154, 160]], gray2: [39, [124, 128, 136]], blue: [40, [120, 150, 186]], teal: [41, [96, 170, 162]],
  roofRed: [42, [178, 70, 58]], roofRed2: [43, [154, 58, 48]], roofDark: [44, [72, 74, 84]], roofDark2: [45, [58, 60, 70]], roofGreen: [46, [84, 128, 96]],
  glass: [47, [140, 190, 220]], glassDark: [48, [60, 96, 128]], windowLit: [49, [255, 214, 140]], frame: [50, [52, 54, 60]],
  door: [51, [120, 80, 52]], awningRed: [52, [206, 64, 60]], awningWhite: [53, [244, 240, 236]], concrete: [54, [176, 176, 170]], concrete2: [55, [156, 156, 150]],
  metal: [56, [170, 176, 184]], metal2: [57, [120, 126, 134]], chimney: [58, [110, 70, 60]], yellowWall: [59, [232, 200, 110]],
  // Props 81-112
  trunk: [81, [110, 78, 52]], leaf: [82, [72, 140, 64]], leaf2: [83, [92, 160, 74]], leaf3: [84, [58, 118, 54]], pine: [85, [48, 104, 70]],
  pole: [86, [70, 74, 80]], lamp: [87, [255, 236, 180]], carRed: [88, [204, 52, 48]], carBlue: [89, [52, 96, 196]], carYellow: [90, [238, 196, 52]],
  carWhite: [91, [236, 236, 236]], carGreen: [92, [72, 160, 84]], carTeal: [93, [60, 170, 170]], tyre: [94, [30, 30, 34]], carGlass: [95, [110, 150, 180]],
  wood: [96, [160, 116, 72]], hydrant: [97, [214, 48, 44]], flower: [98, [236, 112, 160]], flower2: [99, [250, 220, 90]],
};
const C = (k: keyof typeof P) => P[k][0];

const palette: Record<number, [number, number, number]> = {};
for (const [, [i, rgb]] of Object.entries(P)) palette[i] = rgb;
const materials: Record<number, VoxDict> = {
  [C('glass')]: { _type: '_glass', _trans: '0.55', _rough: '0.05', _ri: '1.45', _d: '0.05' },
  [C('glassDark')]: { _type: '_metal', _metal: '0.6', _rough: '0.15' },
  [C('carGlass')]: { _type: '_metal', _metal: '0.5', _rough: '0.1' },
  [C('windowLit')]: { _type: '_emit', _emit: '0.6', _flux: '1' },
  [C('lamp')]: { _type: '_emit', _emit: '1', _flux: '2' },
  [C('metal')]: { _type: '_metal', _metal: '0.8', _rough: '0.3' },
  [C('water')]: { _type: '_metal', _metal: '0.15', _rough: '0.05' },
  [C('waterDeep')]: { _type: '_metal', _metal: '0.15', _rough: '0.05' },
};

// A small deterministic random, so the library is the same every build.
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];

class Vol {
  map = new Map<string, number>();
  constructor(public sx: number, public sy: number, public sz: number) {}
  set(x: number, y: number, z: number, c: number) {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return;
    if (c) this.map.set(`${x},${y},${z}`, c);
    else this.map.delete(`${x},${y},${z}`);
  }
  get(x: number, y: number, z: number) { return this.map.get(`${x},${y},${z}`) ?? 0; }
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: number | (() => number)) {
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, z, typeof c === 'function' ? c() : c);
  }
  /** Hollow box walls (no floor or roof). */
  walls(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: (x: number, y: number, z: number) => number) {
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
      if (x === x0 || x === x1 || y === y0 || y === y1) this.set(x, y, z, c(x, y, z));
  }
  voxels(): [number, number, number, number][] {
    return [...this.map].map(([k, c]) => { const [x, y, z] = k.split(',').map(Number); return [x, y, z, c]; });
  }
}

interface Asset { id: string; name: string; category: string; tags: string[]; vol: Vol; description: string }
const assets: Asset[] = [];
const add = (id: string, name: string, category: string, description: string, vol: Vol, tags: string[] = []) => assets.push({ id, name, category, description, vol, tags });

// ---- Terrain (16×16 tiles) -------------------------------------------------------------------
const tile = (fill: () => number, h = 1) => { const v = new Vol(16, 16, h); v.box(0, 0, 0, 15, 15, h - 1, fill); return v; };
seed = 11; add('16_grass', 'Grass', 'Terrain', '16×16 grass tile, 1 voxel thick', tile(() => pick([C('grass'), C('grass'), C('grass2'), C('grass3')])));
seed = 12; add('16_dirt', 'Dirt', 'Terrain', '16×16 dirt tile', tile(() => pick([C('dirt'), C('dirt'), C('dirt2')])));
seed = 13; add('16_sand', 'Sand', 'Terrain', '16×16 sand tile', tile(() => pick([C('sand'), C('sand'), C('sand2')])));
{
  seed = 14;
  const v = new Vol(16, 16, 1);
  v.box(0, 0, 0, 15, 15, 0, () => (rnd() < 0.08 ? C('foam') : pick([C('water'), C('water'), C('waterDeep')])));
  add('16_water', 'Water', 'Terrain', '16×16 water tile (slightly shiny)', v);
}
{
  seed = 15;
  const v = new Vol(16, 16, 4);
  v.box(0, 0, 0, 15, 15, 0, () => pick([C('grass'), C('grass2'), C('grassDark')]));
  for (let i = 0; i < 26; i++) { const x = Math.floor(rnd() * 16), y = Math.floor(rnd() * 16), h = 1 + Math.floor(rnd() * 3); v.box(x, y, 1, x, y, h, pick([C('rock'), C('rock2')])); }
  add('16_rocks', 'Rocky ground', 'Terrain', '16×16 grass tile with rocks', v);
}
{
  seed = 16;
  const v = new Vol(16, 16, 2);
  v.box(0, 0, 0, 15, 15, 0, () => pick([C('grass'), C('grass3')]));
  for (let i = 0; i < 40; i++) v.set(Math.floor(rnd() * 16), Math.floor(rnd() * 16), 1, pick([C('flower'), C('flower2'), C('leaf2')]));
  add('16_meadow', 'Meadow', 'Terrain', '16×16 grass tile with flowers', v);
}

// ---- Roads (16×16 tiles, 1 high, lanes along Y) ---------------------------------------------
const road = (kind: 'straight' | 'corner' | 't' | 'cross' | 'sidewalk') => {
  const v = new Vol(16, 16, 1);
  if (kind === 'sidewalk') { v.box(0, 0, 0, 15, 15, 0, (() => { let i = 0; return () => ((i++ >> 2) % 2 ? C('sidewalk') : C('sidewalk2')); })()); return v; }
  v.box(0, 0, 0, 15, 15, 0, () => (rnd() < 0.15 ? C('asphalt2') : C('asphalt')));
  const edgeX = kind === 'straight' || kind === 'corner' || kind === 't'; // curb on -X side
  const edgeXp = kind === 'straight'; // curb on +X side
  const edgeY = kind === 'corner'; // curb on -Y side
  if (edgeX) v.box(0, 0, 0, 1, 15, 0, C('sidewalk'));
  if (edgeXp) v.box(14, 0, 0, 15, 15, 0, C('sidewalk'));
  if (edgeY) v.box(0, 0, 0, 15, 1, 0, C('sidewalk'));
  if (edgeX) v.box(2, 0, 0, 2, 15, 0, C('curb'));
  if (edgeXp) v.box(13, 0, 0, 13, 15, 0, C('curb'));
  if (edgeY) v.box(0, 2, 0, 15, 2, 0, C('curb'));
  if (kind === 'straight') for (let y = 0; y < 16; y++) if (y % 6 < 3) v.box(7, y, 0, 8, y, 0, C('laneYellow'));
  if (kind === 'cross') { for (const [a, b] of [[0, 1], [14, 15]]) for (const [c, d] of [[0, 1], [14, 15]]) v.box(a, c, 0, b, d, 0, C('sidewalk')); for (let i = 3; i <= 12; i += 2) { v.set(i, 2, 0, C('laneWhite')); v.set(i, 13, 0, C('laneWhite')); v.set(2, i, 0, C('laneWhite')); v.set(13, i, 0, C('laneWhite')); } }
  if (kind === 't') for (let i = 4; i <= 12; i += 2) v.set(3, i, 0, C('laneWhite'));
  return v;
};
seed = 21; add('16_road', 'Road', 'Roads', 'Straight two-lane road along Y with sidewalks', road('straight'));
seed = 22; add('16_road_corner', 'Road corner', 'Roads', 'Road turning between +X and +Y', road('corner'));
seed = 23; add('16_road_t', 'Road T junction', 'Roads', 'T junction, the stem towards +X', road('t'));
seed = 24; add('16_road_cross', 'Crossroads', 'Roads', 'Four-way crossing with crosswalks', road('cross'));
seed = 25; add('16_sidewalk', 'Sidewalk', 'Roads', 'Paved tile', road('sidewalk'));

// ---- Buildings ----------------------------------------------------------------------------------
{
  // Small house with a gabled roof, door and windows (16×16 lot).
  seed = 31;
  const v = new Vol(16, 16, 15);
  v.box(0, 0, 0, 15, 15, 0, () => pick([C('grass'), C('grass2')]));
  v.box(6, 0, 0, 9, 3, 0, C('sidewalk'));
  v.walls(2, 4, 1, 13, 13, 6, (x, y, z) => ((z === 3 || z === 4) && ((x === 2 || x === 13) ? y % 4 === 1 || y % 4 === 2 : (x % 4 === 1 || x % 4 === 2) && y !== 4) ? C('glass') : C('beige')));
  v.box(7, 4, 1, 8, 4, 4, C('door'));
  v.box(2, 4, 0, 13, 13, 0, C('concrete'));
  for (let i = 0; i <= 6; i++) v.box(1, 3 + i, 7 + i, 14, 3 + i, 7 + i, i % 2 ? C('roofRed2') : C('roofRed')), v.box(1, 14 - i, 7 + i, 14, 14 - i, 7 + i, i % 2 ? C('roofRed2') : C('roofRed'));
  for (let z = 7; z <= 12; z++) for (let y = 4 + (z - 7); y <= 13 - (z - 7); y++) { v.set(2, y, z, C('beige2')); v.set(13, y, z, C('beige2')); }
  v.box(11, 6, 9, 12, 7, 13, C('chimney'));
  add('16_res_house', 'House', 'Buildings', 'Small family house with gabled roof on a 16×16 lot', v, ['residential']);
}
{
  // Apartment block (32×32 lot), 5 floors, balconies.
  seed = 32;
  const v = new Vol(32, 32, 42);
  v.box(0, 0, 0, 31, 31, 0, C('sidewalk'));
  const floors = 5, fh = 7;
  v.walls(3, 3, 1, 28, 28, floors * fh, (x, y, z) => {
    const f = (z - 1) % fh, along = x === 3 || x === 28 ? y : x;
    if (f >= 2 && f <= 4 && along % 5 >= 1 && along % 5 <= 3 && along > 4 && along < 27) return rnd() < 0.25 ? C('windowLit') : C('glass');
    return f === 0 ? C('brick2') : C('brick');
  });
  for (let f = 1; f < floors; f++) for (let x = 6; x <= 25; x += 5) v.box(x, 1, f * fh + 1, x + 2, 2, f * fh + 1, C('concrete')), v.box(x, 1, f * fh + 2, x + 2, 1, f * fh + 2, C('metal2'));
  v.box(3, 3, floors * fh + 1, 28, 28, floors * fh + 1, C('roofDark'));
  v.walls(3, 3, floors * fh + 2, 28, 28, floors * fh + 2, () => C('concrete2'));
  v.box(14, 3, 1, 17, 3, 5, C('door'));
  v.box(20, 20, floors * fh + 2, 23, 23, floors * fh + 5, C('metal'));
  add('32_res_apartment', 'Apartment block', 'Buildings', 'Five-floor brick apartment block on a 32×32 lot', v, ['residential']);
}
{
  // Corner shop with awning (16×16).
  seed = 33;
  const v = new Vol(16, 16, 14);
  v.box(0, 0, 0, 15, 15, 0, C('sidewalk'));
  v.walls(1, 4, 1, 14, 14, 11, (x, y, z) => (y === 4 && z >= 2 && z <= 6 && x > 2 && x < 13 ? (x === 7 || x === 8 ? C('door') : C('glass')) : z >= 8 && z <= 9 && (x % 3 === 1) && y === 4 ? C('windowLit') : C('yellowWall')));
  v.box(1, 4, 12, 14, 14, 12, C('roofDark'));
  for (let x = 1; x <= 14; x++) v.box(x, 1, 7, x, 3, 7, x % 2 ? C('awningRed') : C('awningWhite')), v.set(x, 1, 6, x % 2 ? C('awningRed') : C('awningWhite'));
  v.box(4, 4, 8, 11, 4, 8, C('frame'));
  add('16_com_shop', 'Corner shop', 'Buildings', 'Small shop with striped awning on a 16×16 lot', v, ['commercial']);
}
{
  // Glass office tower (32×32), 64 high.
  seed = 34;
  const v = new Vol(32, 32, 66);
  v.box(0, 0, 0, 31, 31, 0, C('sidewalk'));
  v.box(4, 4, 1, 27, 27, 3, C('concrete'));
  v.walls(6, 6, 4, 25, 25, 60, (x, y, z) => {
    const along = x === 6 || x === 25 ? y : x;
    if (along % 4 === 2 || z % 5 === 4) return C('frame');
    return rnd() < 0.12 ? C('windowLit') : C('glassDark');
  });
  v.box(6, 6, 61, 25, 25, 61, C('roofDark'));
  v.walls(6, 6, 62, 25, 25, 62, () => C('metal2'));
  v.box(12, 12, 62, 19, 19, 64, C('metal'));
  v.box(14, 4, 1, 17, 5, 3, C('glass'));
  add('32_com_office', 'Office tower', 'Buildings', 'Glass office tower, 64 high, on a 32×32 lot', v, ['commercial']);
}
{
  // Factory with saw-tooth roof and chimney (32×32).
  seed = 35;
  const v = new Vol(32, 32, 34);
  v.box(0, 0, 0, 31, 31, 0, C('concrete2'));
  v.walls(2, 6, 1, 29, 29, 10, (x, y, z) => (z >= 5 && z <= 7 && (x === 2 || x === 29 ? y % 6 < 3 : x % 6 < 3) ? C('glass') : C('gray')));
  for (let x = 2; x <= 29; x++) for (let k = 0; k < 4; k++) { const y0 = 6 + k * 6; for (let s = 0; s < 6; s++) v.box(x, y0 + s, 11, x, y0 + s, 11 + Math.min(s, 4), s === 5 ? C('glass') : C('roofDark')); }
  v.box(24, 1, 1, 27, 4, 30, C('chimney'));
  v.box(24, 1, 31, 27, 4, 31, C('roofDark2'));
  v.box(8, 6, 1, 13, 6, 6, C('metal2'));
  for (let i = 0; i < 4; i++) v.box(4 + i * 5, 1, 1, 6 + i * 5, 3, 2, pick([C('metal'), C('metal2'), C('wood')]));
  add('32_ind_factory', 'Factory', 'Buildings', 'Factory with saw-tooth roof and chimney on a 32×32 lot', v, ['industrial']);
}

// ---- Props --------------------------------------------------------------------------------------
{
  seed = 41;
  const v = new Vol(5, 5, 7);
  v.box(2, 2, 0, 2, 2, 2, C('trunk'));
  for (let z = 2; z <= 6; z++) for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) if ((x - 2) ** 2 + (y - 2) ** 2 + ((z - 4) * 1.2) ** 2 <= 6.2) v.set(x, y, z, pick([C('leaf'), C('leaf2'), C('leaf3')]));
  add('x_tree', 'Tree', 'Props', 'Round leafy tree, 5×5×7', v, ['nature']);
}
{
  seed = 42;
  const v = new Vol(5, 5, 9);
  v.box(2, 2, 0, 2, 2, 1, C('trunk'));
  for (let z = 1; z <= 8; z++) { const r = Math.max(0, 2.6 - (z - 1) * 0.33); for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) if (Math.hypot(x - 2, y - 2) <= r) v.set(x, y, z, z % 2 ? C('pine') : C('leaf3')); }
  add('x_tree_pine', 'Pine tree', 'Props', 'Pine tree, 5×5×9', v, ['nature']);
}
{
  const v = new Vol(1, 3, 9);
  v.box(0, 0, 0, 0, 0, 8, C('pole'));
  v.box(0, 1, 8, 0, 2, 8, C('pole'));
  v.set(0, 2, 7, C('lamp'));
  add('x_streetlight', 'Street light', 'Props', 'Street light that glows, 1×3×9; the lamp hangs towards +Y', v, ['street']);
}
const car = (body: keyof typeof P) => { const v = new Vol(2, 4, 2); v.box(0, 0, 0, 1, 3, 0, C(body)); v.box(0, 1, 1, 1, 2, 1, C('carGlass')); v.set(0, 0, 0, C('tyre')); v.set(1, 3, 0, C('tyre')); v.set(1, 0, 0, C(body)); return v; };
add('x_car_red', 'Car (red)', 'Props', 'Tiny car, 2×4×2, facing +Y', car('carRed'), ['vehicle']);
add('x_car_blue', 'Car (blue)', 'Props', 'Tiny car, 2×4×2, facing +Y', car('carBlue'), ['vehicle']);
add('x_car_yellow', 'Taxi', 'Props', 'Tiny yellow car, 2×4×2, facing +Y', car('carYellow'), ['vehicle']);
add('x_car_white', 'Car (white)', 'Props', 'Tiny car, 2×4×2, facing +Y', car('carWhite'), ['vehicle']);
{
  const v = new Vol(4, 2, 2);
  v.box(0, 0, 0, 0, 1, 0, C('metal2')); v.box(3, 0, 0, 3, 1, 0, C('metal2'));
  v.box(0, 0, 1, 3, 1, 1, C('wood'));
  add('x_bench', 'Bench', 'Props', 'Park bench, 4×2×2', v, ['street']);
}
{
  const v = new Vol(1, 1, 2);
  v.box(0, 0, 0, 0, 0, 1, C('hydrant'));
  add('x_hydrant', 'Fire hydrant', 'Props', 'Fire hydrant, 1×1×2', v, ['street']);
}
{
  // A park tile: grass, path, trees and a bench (16×16).
  seed = 43;
  const v = new Vol(16, 16, 8);
  v.box(0, 0, 0, 15, 15, 0, () => pick([C('grass'), C('grass2'), C('grass3')]));
  v.box(7, 0, 0, 8, 15, 0, C('sand'));
  for (const [tx, ty] of [[2, 2], [11, 3], [3, 11], [11, 11]]) {
    v.box(tx + 2, ty + 2, 1, tx + 2, ty + 2, 3, C('trunk'));
    for (let z = 3; z <= 7; z++) for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) if ((x - 2) ** 2 + (y - 2) ** 2 + ((z - 5) * 1.2) ** 2 <= 6.2) v.set(tx + x, ty + y, z, pick([C('leaf'), C('leaf2'), C('leaf3')]));
  }
  v.box(5, 7, 1, 5, 9, 1, C('wood')); v.box(10, 7, 1, 10, 9, 1, C('wood'));
  add('16_park', 'Park', 'Buildings', '16×16 park with a path, trees and benches', v, ['nature']);
}

// ---- Write -----------------------------------------------------------------------------------
const dir = 'public/library';
mkdirSync(dir, { recursive: true });
const index = assets.map((a) => {
  const voxels = a.vol.voxels();
  writeFileSync(join(dir, `${a.id}.vox`), writeVox({
    objects: [{ name: a.id, size: [a.vol.sx, a.vol.sy, a.vol.sz], voxels, translation: [0, 0, Math.floor(a.vol.sz / 2)] }],
    palette, materials,
  }));
  return { id: a.id, name: a.name, category: a.category, description: a.description, tags: a.tags, size: [a.vol.sx, a.vol.sy, a.vol.sz], voxels: voxels.length, file: `${a.id}.vox` };
});
writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, palette: 'Terrain 1-16 · Roads 17-32 · Buildings 33-80 · Props 81-112', assets: index }, null, 2));
console.log(`${index.length} assets written to ${dir}`);
