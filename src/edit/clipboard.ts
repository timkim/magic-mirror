// The editor's clipboard: an object or group with its models and the colours it uses. Kept in
// localStorage, so a copy from one scene pastes into another (and survives a reload).

import type { SceneNode, VoxDict } from '../vox/types';

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
