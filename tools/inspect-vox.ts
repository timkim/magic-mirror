// Print what's in a .vox file: models, layers, materials, render settings, cameras, bounds.
//   npx tsx tools/inspect-vox.ts scene.vox

import { readFileSync } from 'node:fs';
import { parseVox } from '../src/vox/parser';
import { animationLength, buildVoxelGrid, placeModels } from '../src/vox/scene';

const f = parseVox(readFileSync(process.argv[2]));
const placed = placeModels(f);
console.log('version', f.version, 'models', f.models.length, 'placed', placed.length, 'nodes', f.nodes.size, 'anim frames', animationLength(f), 'other chunks', f.unknownChunks);
console.log('layers', [...f.layers.values()].map((l) => `${l.id}:${l.attrs._name ?? ''}${l.hidden ? '(hidden)' : ''}`).join(' '));
console.log('names', [...new Set(placed.map((p) => p.name))].slice(0, 40).join(', '));
const special = [...f.materials].filter(([, d]) => d._type && d._type !== '_diffuse');
console.log(`non-diffuse materials (${special.length}):`);
for (const [i, d] of special.slice(0, 30)) console.log(' ', i, JSON.stringify(d));
for (const d of f.renderObjects) console.log('rOBJ', JSON.stringify(d));
for (const c of f.cameras) if (Number(c.attrs._radius) > 0 || Number(c.attrs._frustum) > 0) console.log('rCAM', c.id, JSON.stringify(c.attrs));
const t = performance.now();
const g = buildVoxelGrid(f);
console.log('grid', g.dims.join('×'), 'origin', g.origin.join(','), 'voxels', g.voxelCount, `${(performance.now() - t).toFixed(0)}ms`);
