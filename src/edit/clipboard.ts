// The editor's clipboard: an object or group with its models and the colours it uses. Kept in
// localStorage, so a copy from one scene pastes into another (and survives a reload).

import type { SceneNode, VoxDict, VoxFile, VoxModel } from '../vox/types';
import { emptyScene } from '../vox/empty';
import { buildVoxelGrid } from '../vox/scene';

export interface Clip {
  kind: 'magic-mirror-clip';
  name: string;
  /** The subtree, root transform first, with its original node ids. */
  nodes: SceneNode[];
  /** Models it uses: voxels as base64 of the XYZI bytes. */
  models: { id: number; size: number[]; voxels: string }[];
  /** Palette entries (and materials) its voxels use, so pasting elsewhere keeps the look. */
  colors: { index: number; rgba: number[]; material?: VoxDict }[];
  /** Lowest world z and the x, y centre of what was copied. */
  bottom: number;
  center: [number, number];
  /** Width and depth of what was copied. */
  extent?: [number, number];
  /** Set for pieces placed from the asset library. */
  fromLibrary?: boolean;
}

const KEY = 'mm.clipboard';
let memory: Clip | null = null;

export const Clipboard = {
  save(c: Clip) {
    memory = c;
    try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* too big or private mode: memory only */ }
  },
  load(): Clip | null {
    if (memory) return memory;
    try {
      const c = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      return c?.kind === 'magic-mirror-clip' ? c : null;
    } catch {
      return null;
    }
  },
};

// ---- Clips ⇄ .vox files (library assets are plain .vox files) ----------------------------------


const b64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Everything in a .vox as one clip (several top-level objects get wrapped in a group). */
export function clipFromVox(file: VoxFile, name: string): Clip {
  const root = file.nodes.get(0);
  const top = root?.kind === 'transform' ? file.nodes.get(root.childId) : undefined;
  const kids = top?.kind === 'group' ? top.childIds : [];
  const sub: SceneNode[] = [];
  const visit = (id: number) => {
    const n = file.nodes.get(id);
    if (!n || sub.includes(n)) return;
    sub.push(n);
    if (n.kind === 'transform') visit(n.childId);
    else if (n.kind === 'group') n.childIds.forEach(visit);
  };
  let nodes: SceneNode[];
  if (kids.length === 1) {
    visit(kids[0]);
    nodes = sub;
  } else {
    const next = Math.max(0, ...file.nodes.keys()) + 1;
    kids.forEach(visit);
    nodes = [
      { kind: 'transform', id: next, attrs: { _name: name }, childId: next + 1, layerId: 0, frames: [{ rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] }] },
      { kind: 'group', id: next + 1, attrs: {}, childIds: [...kids] },
      ...sub,
    ];
  }
  const modelIds = new Set<number>();
  for (const n of nodes) if (n.kind === 'shape') for (const m of n.models) modelIds.add(m.modelId);
  const used = new Set<number>();
  for (const id of modelIds) { const v = file.models[id]?.voxels ?? new Uint8Array(); for (let i = 3; i < v.length; i += 4) used.add(v[i]); }
  const g = buildVoxelGrid(file);
  return {
    kind: 'magic-mirror-clip',
    name,
    nodes: nodes.map((n) => (n.kind === 'transform' ? { ...n, frames: n.frames.map((f) => ({ ...f, attrs: undefined })) } : n)),
    models: [...modelIds].map((id) => ({ id, size: file.models[id].size, voxels: b64(file.models[id].voxels) })),
    colors: [...used].map((i) => ({ index: i, rgba: Array.from(file.palette.subarray(i * 4, i * 4 + 4)), material: file.materials.get(i) })),
    bottom: g.origin[2],
    center: [Math.round(g.origin[0] + g.dims[0] / 2 - 0.5), Math.round(g.origin[1] + g.dims[1] / 2 - 0.5)],
    extent: [g.dims[0], g.dims[1]],
    fromLibrary: true,
  };
}

/** A standalone scene holding just the clip (for saving an asset as .vox, and thumbnails). */
export function fileFromClip(clip: Clip): VoxFile {
  const file = emptyScene();
  const modelIds = new Map<number, number>();
  for (const m of clip.models) {
    modelIds.set(m.id, file.models.length);
    file.models.push({ size: m.size as VoxModel['size'], voxels: Uint8Array.from(atob(m.voxels), (c) => c.charCodeAt(0)) });
  }
  let next = 2;
  const ids = new Map(clip.nodes.map((n) => [n.id, next++]));
  for (const n of clip.nodes) {
    const id = ids.get(n.id)!;
    if (n.kind === 'transform') file.nodes.set(id, { ...n, id, childId: ids.get(n.childId) ?? -1, layerId: 0 });
    else if (n.kind === 'group') file.nodes.set(id, { ...n, id, childIds: n.childIds.map((c) => ids.get(c)!).filter((c) => c !== undefined) });
    else file.nodes.set(id, { ...n, id, models: n.models.map((m) => ({ ...m, modelId: modelIds.get(m.modelId) ?? 0 })) });
  }
  (file.nodes.get(1) as { childIds: number[] }).childIds.push(ids.get(clip.nodes[0].id)!);
  for (const c of clip.colors) {
    file.palette.set(c.rgba, c.index * 4);
    if (c.material) file.materials.set(c.index, c.material);
  }
  return file;
}
