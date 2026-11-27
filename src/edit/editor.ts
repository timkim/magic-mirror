// The voxel editor, modelled on MagicaVoxel's model mode: pick a model, then Attach, Erase or
// Paint with a Voxel, Box or Face brush, optionally mirrored. Every change is an undoable
// command, and the same methods (setVoxels, setColor, setMaterial, addModel) are what scripts
// and the AI assistant call.

import { get, writable } from 'svelte/store';
import { IDENTITY_ROT } from '../vox/parser';
import { placementBounds, worldToModel, type PlacedModel } from '../vox/scene';
import type { GroupNode, VoxDict, VoxFile } from '../vox/types';
import type { Command, History } from './history';
import { cameraRay, castRay, planeCell, type GridHit } from './pick';
import { ModelVolume } from './volume';
import type { FrameParams } from '../render/renderer';
import type { VoxelGrid } from '../vox/scene';

export type EditMode = 'attach' | 'erase' | 'paint';
export type Brush = 'voxel' | 'box' | 'face';
type V3 = [number, number, number];

/** What the editor needs from the app (kept small so it also works headless). */
export interface EditorHost {
  readonly file: VoxFile | null;
  readonly grid: VoxelGrid | null;
  placements(): readonly PlacedModel[];
  cameraFrame(): FrameParams['camera'] | null;
  modelsChanged(modelIds: number[]): void;
  materialsChanged(): void;
  /** The scene graph or a model size changed: rebuild everything, keeping the view. */
  structureChanged(): void;
  setStatus(id: string, text: string): void;
}

/** One voxel change inside a model: cell index -> colour before and after. */
type Diff = Map<number, [number, number]>;

export interface Preview {
  /** World-space inclusive voxel boxes to outline. */
  boxes: { min: V3; max: V3; kind: 'target' | 'model' }[];
}

export class VoxelEditor {
  readonly enabled = writable(false);
  readonly mode = writable<EditMode>('attach');
  readonly brush = writable<Brush>('voxel');
  /** Palette index used to attach and paint. */
  readonly color = writable(1);
  readonly mirror = writable({ x: false, y: false, z: false });
  /** Index into the current placements of the model being edited. */
  readonly selected = writable<number | null>(null);
  readonly preview = writable<Preview>({ boxes: [] });

  private volumes = new Map<number, ModelVolume>();
  private stroke: { modelId: number; diff: Diff; label: string; start?: { cell: V3; axis: number; plane: number; hit: GridHit } } | null = null;

  constructor(readonly host: EditorHost, readonly history: History) {}

  /** Forget cached volumes (after opening a file, or undoing a structural change). */
  reset() {
    this.volumes.clear();
    this.stroke = null;
    this.selected.set(null);
    this.preview.set({ boxes: [] });
  }

  volume(modelId: number) {
    const file = this.host.file!;
    let v = this.volumes.get(modelId);
    if (!v || v.model !== file.models[modelId]) {
      v = new ModelVolume(file.models[modelId]);
      this.volumes.set(modelId, v);
    }
    return v;
  }

  selectedPlacement(): PlacedModel | null {
    const i = get(this.selected);
    return i === null ? null : (this.host.placements()[i] ?? null);
  }

  // ---- Scripting / assistant API -------------------------------------------------------

  /** Set voxels of one model in its own coordinates (colour 0 erases). One undo step. */
  setVoxels(modelId: number, voxels: [number, number, number, number][], label = 'Edit voxels') {
    const vol = this.volume(modelId);
    const diff: Diff = new Map();
    for (const [x, y, z, c] of voxels) {
      if (!vol.inside(x, y, z)) continue;
      const i = vol.index(x, y, z);
      const before = diff.get(i)?.[0] ?? vol.cells[i];
      diff.set(i, [before, c]);
    }
    for (const [i, [a, b]] of diff) if (a === b) diff.delete(i);
    if (diff.size === 0) return 0;
    this.history.run(this.diffCommand(modelId, diff, label));
    return diff.size;
  }

  /** Change one palette colour (RGBA bytes). */
  setColor(index: number, rgba: [number, number, number, number], label = `Colour ${index}`) {
    const file = this.host.file!;
    const before = Array.from(file.palette.subarray(index * 4, index * 4 + 4)) as [number, number, number, number];
    if (before.every((v, i) => v === rgba[i])) return;
    const set = (c: number[]) => {
      file.palette.set(c, index * 4);
      this.host.materialsChanged();
    };
    this.history.run({ label, apply: () => set(rgba), revert: () => set(before) });
  }

  /** Replace one palette entry's material (MATL keys, e.g. {_type: '_metal', _rough: '0.2'}). */
  setMaterial(index: number, dict: VoxDict, label = `Material ${index}`) {
    const file = this.host.file!;
    const before = file.materials.get(index);
    const set = (d: VoxDict | undefined) => {
      if (d) file.materials.set(index, d);
      else file.materials.delete(index);
      this.host.materialsChanged();
    };
    this.history.run({ label, apply: () => set({ _type: '_diffuse', ...dict }), revert: () => set(before) });
  }

  /** Add an empty model of the given size centred at `at` (world). Returns its model id. */
  addModel(size: V3, at: V3, name = 'model') {
    const file = this.host.file!;
    const root = file.nodes.get(0);
    const groupId = root?.kind === 'transform' ? root.childId : -1;
    if (file.nodes.get(groupId)?.kind !== 'group') throw new Error('This file has no scene group to add models to.');
    const next = Math.max(-1, ...file.nodes.keys()) + 1;
    const modelId = file.models.length;
    const model = { size: size.map((v) => Math.max(1, Math.min(256, Math.round(v)))) as V3, voxels: new Uint8Array(0) };
    const layerId = Math.min(...[...file.layers.keys(), 0]);
    const trn = { kind: 'transform' as const, id: next, attrs: { _name: name }, childId: next + 1, layerId, frames: [{ rotation: IDENTITY_ROT, translation: at.map(Math.round) as V3 }] };
    const shp = { kind: 'shape' as const, id: next + 1, attrs: {}, models: [{ modelId }] };
    const group = () => file.nodes.get(groupId) as GroupNode;
    const apply = () => {
      file.models[modelId] = model;
      file.nodes.set(trn.id, trn);
      file.nodes.set(shp.id, shp);
      group().childIds.push(next);
      this.host.structureChanged();
      const idx = this.host.placements().findIndex((p) => p.modelId === modelId);
      this.selected.set(idx >= 0 ? idx : null);
    };
    const revert = () => {
      group().childIds = group().childIds.filter((c) => c !== next);
      file.nodes.delete(trn.id);
      file.nodes.delete(shp.id);
      file.models.length = modelId;
      this.selected.set(null);
      this.host.structureChanged();
    };
    this.history.run({ label: `New model "${name}"`, apply, revert });
    return modelId;
  }

  private diffCommand(modelId: number, diff: Diff, label: string): Command {
    const write = (k: 0 | 1) => {
      const vol = this.volume(modelId);
      for (const [i, d] of diff) vol.cells[i] = d[k];
      vol.pack();
      this.host.modelsChanged([modelId]);
    };
    return { label, apply: () => write(1), revert: () => write(0) };
  }

  // ---- Pointer tool ----------------------------------------------------------------------

  private ray(u: number, v: number, aspect: number) {
    const cam = this.host.cameraFrame();
    return cam ? cameraRay(cam, u, v, aspect) : null;
  }

  /** Which placed model owns a world voxel (the last one drawn there, like the baker). */
  ownerOf(cell: V3): number | null {
    const file = this.host.file!;
    const ps = this.host.placements();
    for (let i = ps.length - 1; i >= 0; i--) {
      const l = worldToModel(file, ps[i], cell);
      if (this.volume(ps[i].modelId).get(...l)) return i;
    }
    return null;
  }

  private toWorld(p: PlacedModel, l: V3): V3 {
    const s = this.host.file!.models[p.modelId].size, r = p.rotation;
    const d = [l[0] - Math.floor(s[0] / 2), l[1] - Math.floor(s[1] / 2), l[2] - Math.floor(s[2] / 2)];
    return [0, 1, 2].map((i) => r[i * 3] * d[0] + r[i * 3 + 1] * d[1] + r[i * 3 + 2] * d[2] + p.translation[i]) as V3;
  }

  /** Model-space cells a brush would change, given a hit (before mirroring). */
  private targets(p: PlacedModel, hit: GridHit, mode: EditMode, brush: Brush, boxEnd?: V3): V3[] {
    const file = this.host.file!;
    const vol = this.volume(p.modelId);
    const base: V3 = mode === 'attach' ? [hit.cell[0] + hit.normal[0], hit.cell[1] + hit.normal[1], hit.cell[2] + hit.normal[2]] : hit.cell;
    if (mode !== 'attach' && (hit.ground || this.ownerOf(hit.cell) !== get(this.selected))) return [];
    const start = worldToModel(file, p, base);
    if (brush === 'box' && boxEnd) {
      const end = worldToModel(file, p, boxEnd);
      const lo = start.map((v, i) => Math.max(0, Math.min(v, end[i]))), hi = start.map((v, i) => Math.min(vol.size[i] - 1, Math.max(v, end[i])));
      const out: V3[] = [];
      for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) out.push([x, y, z]);
      return out;
    }
    if (brush === 'face' && !hit.ground) {
      // Flood the visible, same-coloured face around the hit voxel, within its plane.
      const r = p.rotation, n = hit.normal;
      const nl = [0, 1, 2].map((j) => r[j] * n[0] + r[3 + j] * n[1] + r[6 + j] * n[2]) as V3;
      const seed = worldToModel(file, p, hit.cell);
      const colour = vol.get(...seed);
      const axis = nl.findIndex((v) => v !== 0);
      const dirs = [0, 1, 2].filter((a) => a !== axis).flatMap((a) => [1, -1].map((s) => { const d: V3 = [0, 0, 0]; d[a] = s; return d; }));
      const seen = new Set([vol.index(...seed)]);
      const queue: V3[] = [seed];
      const out: V3[] = [];
      while (queue.length && out.length < 65536) {
        const c = queue.pop()!;
        out.push(mode === 'attach' ? [c[0] + nl[0], c[1] + nl[1], c[2] + nl[2]] : c);
        for (const d of dirs) {
          const q: V3 = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
          if (!vol.inside(...q) || seen.has(vol.index(...q))) continue;
          if (vol.get(...q) !== colour || vol.get(q[0] + nl[0], q[1] + nl[1], q[2] + nl[2])) continue;
          seen.add(vol.index(...q));
          queue.push(q);
        }
      }
      return out.filter((c) => vol.inside(...c));
    }
    return vol.inside(...start) ? [start] : [];
  }

  private mirrored(modelId: number, cells: V3[]): V3[] {
    const m = get(this.mirror), s = this.volume(modelId).size;
    let out = cells;
    (['x', 'y', 'z'] as const).forEach((k, a) => {
      if (m[k]) out = out.flatMap((c) => { const d: V3 = [...c]; d[a] = s[a] - 1 - c[a]; return [c, d]; });
    });
    return out;
  }

  private addToStroke(cells: V3[]) {
    const st = this.stroke!;
    const vol = this.volume(st.modelId);
    const mode = get(this.mode);
    const c = mode === 'erase' ? 0 : get(this.color);
    let changed = false;
    for (const cell of this.mirrored(st.modelId, cells)) {
      if (!vol.inside(...cell)) continue;
      const i = vol.index(...cell);
      const now = vol.cells[i];
      if (mode === 'paint' && now === 0) continue;
      if (mode === 'attach' && now !== 0) continue;
      if (now === c) continue;
      if (!st.diff.has(i)) st.diff.set(i, [now, c]);
      else st.diff.get(i)![1] = c;
      vol.cells[i] = c;
      changed = true;
    }
    if (changed) {
      vol.pack();
      this.host.modelsChanged([st.modelId]);
    }
  }

  /** Pointer pressed on the render (u, v in 0..1). Returns true if the editor used it. */
  pointerDown(u: number, v: number, aspect: number, e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
    if (!get(this.enabled) || !this.host.grid) return false;
    const r = this.ray(u, v, aspect);
    if (!r) return true;
    const hit = castRay(this.host.grid, r.origin, r.dir);
    if (e.altKey) {
      // Eyedropper.
      if (hit && !hit.ground) {
        const g = this.host.grid, o = g.origin;
        const c = g.cells[hit.cell[0] - o[0] + g.dims[0] * (hit.cell[1] - o[1] + g.dims[1] * (hit.cell[2] - o[2]))];
        if (c) this.color.set(c);
      }
      return true;
    }
    const owner = hit && !hit.ground ? this.ownerOf(hit.cell) : null;
    if (e.ctrlKey || e.metaKey || get(this.selected) === null) {
      if (owner !== null) {
        this.selected.set(owner);
        const p = this.host.placements()[owner];
        this.host.setStatus('msg', `Editing ${p.name ?? `model ${p.modelId}`}`);
      }
      this.hover(u, v, aspect);
      return true;
    }
    const p = this.selectedPlacement();
    if (!p || !hit) return true;
    const mode = get(this.mode), brush = get(this.brush);
    const names = { attach: 'Attach', erase: 'Erase', paint: 'Paint' };
    this.stroke = { modelId: p.modelId, diff: new Map(), label: `${names[mode]} (${brush})` };
    const base: V3 = mode === 'attach' ? [hit.cell[0] + hit.normal[0], hit.cell[1] + hit.normal[1], hit.cell[2] + hit.normal[2]] : hit.cell;
    const axis = hit.normal.findIndex((x) => x !== 0);
    this.stroke.start = { cell: base, axis, plane: base[axis] + 0.5, hit };
    if (brush !== 'box') this.addToStroke(this.targets(p, hit, mode, brush));
    else this.preview.set({ boxes: [...this.modelBox(), { min: base, max: base, kind: 'target' }] });
    return true;
  }

  pointerMove(u: number, v: number, aspect: number) {
    if (!this.stroke) return this.hover(u, v, aspect);
    const p = this.selectedPlacement(), r = this.ray(u, v, aspect), st = this.stroke.start;
    if (!p || !r || !st) return;
    const mode = get(this.mode), brush = get(this.brush);
    if (brush === 'box' || (brush === 'voxel' && mode === 'attach')) {
      // Stay on the plane the stroke started on, so attaching doesn't climb towards the camera.
      const end = planeCell(r.origin, r.dir, st.axis, st.plane);
      if (!end) return;
      if (brush === 'box') {
        const lo = st.cell.map((x, i) => Math.min(x, end[i])) as V3, hi = st.cell.map((x, i) => Math.max(x, end[i])) as V3;
        this.preview.set({ boxes: [...this.modelBox(), { min: lo, max: hi, kind: 'target' }] });
        this.stroke.start = { ...st };
        (this.stroke as { end?: V3 }).end = end;
      } else {
        const l = worldToModel(this.host.file!, p, end);
        this.addToStroke([l]);
        this.hover(u, v, aspect);
      }
      return;
    }
    const hit = castRay(this.host.grid!, r.origin, r.dir);
    if (hit) this.addToStroke(this.targets(p, hit, mode, brush));
    this.hover(u, v, aspect);
  }

  pointerUp() {
    const st = this.stroke;
    if (!st) return;
    const p = this.selectedPlacement();
    const end = (st as { end?: V3 }).end;
    if (get(this.brush) === 'box' && p && st.start) this.addToStroke(this.targets(p, st.start.hit, get(this.mode), 'box', end ?? st.start.cell));
    this.stroke = null;
    for (const [i, [a, b]] of st.diff) if (a === b) st.diff.delete(i);
    if (st.diff.size) {
      // Already applied while drawing; record it for undo.
      this.history.push(this.diffCommand(st.modelId, st.diff, `${st.label}: ${st.diff.size} voxels`));
    }
    this.preview.set({ boxes: this.modelBox() });
  }

  private modelBox(): Preview['boxes'] {
    const p = this.selectedPlacement();
    if (!p || !this.host.file) return [];
    const b = placementBounds(this.host.file, p);
    return [{ min: b.lo as V3, max: b.hi as V3, kind: 'model' }];
  }

  hover(u: number, v: number, aspect: number) {
    if (!get(this.enabled) || !this.host.grid) return;
    const r = this.ray(u, v, aspect);
    const boxes = this.modelBox();
    const hit = r && castRay(this.host.grid, r.origin, r.dir);
    const p = this.selectedPlacement();
    if (hit) {
      if (!p) {
        const owner = hit.ground ? null : this.ownerOf(hit.cell);
        if (owner !== null) {
          const b = placementBounds(this.host.file!, this.host.placements()[owner]);
          boxes.push({ min: b.lo as V3, max: b.hi as V3, kind: 'target' });
        }
      } else {
        const cells = this.mirrored(p.modelId, this.targets(p, hit, get(this.mode), get(this.brush) === 'face' ? 'face' : 'voxel'));
        if (cells.length) {
          const w = cells.slice(0, 4096).map((c) => this.toWorld(p, c));
          if (get(this.brush) === 'face') {
            const lo = [0, 1, 2].map((i) => Math.min(...w.map((c) => c[i]))) as V3, hi = [0, 1, 2].map((i) => Math.max(...w.map((c) => c[i]))) as V3;
            boxes.push({ min: lo, max: hi, kind: 'target' });
          } else for (const c of w) boxes.push({ min: c, max: c, kind: 'target' });
        }
      }
    }
    this.preview.set({ boxes });
  }

  leave() {
    if (!this.stroke) this.preview.set({ boxes: this.modelBox() });
  }
}
