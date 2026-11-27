// The voxel editor, modelled on MagicaVoxel's model mode: pick a model, then Attach, Erase or
// Paint with a Voxel, Box, Face, Line or Sphere brush, optionally mirrored, or Move it. Every
// change is an undoable command, and the same methods (setVoxels, setColor, setMaterial,
// addModel, moveObject, rotateObject, resizeModel, setObject, setLayer) are what scripts and
// the AI assistant call.

import { get, writable } from 'svelte/store';
import { IDENTITY_ROT } from '../vox/parser';
import { placementBounds, worldToModel, type PlacedModel } from '../vox/scene';
import type { GroupNode, Rot3, SceneNode, TransformFrame, TransformNode, VoxDict, VoxFile, VoxModel } from '../vox/types';
import { Clipboard, type Clip } from './clipboard';
import { shapeCells } from './shapes';
import type { Command, History } from './history';
import { cameraRay, castRay, planeCell, type GridHit } from './pick';
import { ModelVolume } from './volume';
import type { FrameParams } from '../render/renderer';
import type { VoxelGrid } from '../vox/scene';

export type EditMode = 'attach' | 'erase' | 'paint' | 'move';
export type Brush = 'voxel' | 'box' | 'face' | 'line' | 'sphere';
/** Brushes that drag from a start cell to an end cell on the plane where the drag began. */
const DRAG_BRUSHES: Brush[] = ['box', 'line', 'sphere'];

function mulRot(a: Rot3, b: Rot3): Rot3 {
  const o = [0, 0, 0, 0, 0, 0, 0, 0, 0] as Rot3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}
const applyRot = (r: Rot3, v: number[]): V3 => [0, 1, 2].map((i) => r[i * 3] * v[0] + r[i * 3 + 1] * v[1] + r[i * 3 + 2] * v[2]) as V3;
const toBase64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/** A quarter turn about Z (counter-clockwise seen from above). */
const ROT_Z90: Rot3 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
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
  /** The object being edited: the id of its transform node. */
  readonly selected = writable<number | null>(null);
  readonly preview = writable<Preview>({ boxes: [] });

  private volumes = new Map<number, ModelVolume>();
  private stroke: { modelId: number; diff: Diff; label: string; start?: { cell: V3; axis: number; plane: number; hit: GridHit }; end?: V3 } | null = null;
  private moving: { nodeId: number; axis: number; plane: number; from: V3; delta: V3 } | null = null;

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
    const id = get(this.selected);
    return id === null ? null : (this.host.placements().find((p) => p.nodeId === id) ?? null);
  }

  /** Every placed model under the selected object or group. */
  selectionPlacements(): PlacedModel[] {
    const id = get(this.selected);
    if (id === null) return [];
    return this.host.placements().filter((p) => p.nodeId === id || p.path?.includes(id));
  }

  /** Select an object (by transform node id) and say so in the status bar. */
  select(nodeId: number | null) {
    this.selected.set(nodeId);
    const node = nodeId === null ? undefined : this.host.file?.nodes.get(nodeId);
    if (node) this.host.setStatus('msg', `Selected ${node.attrs._name ?? (this.selectedPlacement() ? `model ${this.selectedPlacement()!.modelId}` : `group ${nodeId}`)}`);
    this.preview.set({ boxes: this.modelBox() });
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
      this.selected.set(trn.id);
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

  /**
   * Replace an object's transform frames (its position, rotation and keyframes). One frame with
   * no `frame` number makes it static. Translations are relative to its parent, like the file.
   */
  setTransform(nodeId: number, frames: TransformFrame[], label = 'Move object') {
    const file = this.host.file!;
    const node = file.nodes.get(nodeId);
    if (node?.kind !== 'transform') throw new Error(`No object with id ${nodeId}`);
    const before = node.frames;
    const after = frames.map((f) => ({ ...f, attrs: undefined }));
    const set = (fr: TransformFrame[]) => {
      node.frames = fr;
      this.host.structureChanged();
    };
    this.history.run({ label, apply: () => set(after), revert: () => set(before) });
  }

  private transform(nodeId: number) {
    const node = this.host.file!.nodes.get(nodeId);
    if (node?.kind !== 'transform') throw new Error(`No object with id ${nodeId}`);
    return node;
  }

  /** Move an object by whole voxels. Keyframed objects move every key, keeping the animation. */
  moveObject(nodeId: number, delta: V3, label = 'Move object') {
    if (delta.every((d) => d === 0)) return;
    const node = this.transform(nodeId);
    this.setTransform(nodeId, node.frames.map((f) => ({ ...f, translation: f.translation.map((v, i) => v + Math.round(delta[i])) as V3 })), label);
  }

  /** Turn an object about Z by quarter turns (1 = 90° counter-clockwise from above), in place. */
  rotateObject(nodeId: number, quarterTurns: number, label = 'Rotate object') {
    const turns = ((Math.round(quarterTurns) % 4) + 4) % 4;
    if (!turns) return;
    const node = this.transform(nodeId);
    let r: Rot3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let i = 0; i < turns; i++) r = mulRot(ROT_Z90, r);
    this.setTransform(nodeId, node.frames.map((f) => ({ ...f, rotation: mulRot(r, f.rotation) })), label);
  }

  /**
   * Change a model's box size. `offset` shifts its voxels inside the new box (e.g. grow it
   * downwards by [0, 0, 4] with a size 4 taller); voxels that fall outside are cut. Every object
   * showing this model is moved so its voxels stay where they were in the world.
   */
  resizeModel(modelId: number, size: V3, offset: V3 = [0, 0, 0], label = 'Resize model') {
    const file = this.host.file!;
    const old = file.models[modelId];
    if (!old) throw new Error(`No model ${modelId}`);
    const ns = size.map((v) => Math.max(1, Math.min(256, Math.round(v)))) as V3;
    const off = offset.map(Math.round) as V3;
    const kept: number[] = [];
    for (let i = 0; i < old.voxels.length; i += 4) {
      const x = old.voxels[i] + off[0], y = old.voxels[i + 1] + off[1], z = old.voxels[i + 2] + off[2];
      if (x >= 0 && y >= 0 && z >= 0 && x < ns[0] && y < ns[1] && z < ns[2]) kept.push(x, y, z, old.voxels[i + 3]);
    }
    const next = { size: ns, voxels: new Uint8Array(kept) };
    // Pivots sit at floor(size / 2), so compensate each object that shows only this model.
    const shift = [0, 1, 2].map((i) => Math.floor(ns[i] / 2) - Math.floor(old.size[i] / 2) - off[i]);
    const moves: { node: TransformNode; before: TransformFrame[]; after: TransformFrame[] }[] = [];
    for (const n of file.nodes.values()) {
      if (n.kind !== 'transform') continue;
      const child = file.nodes.get(n.childId);
      if (child?.kind !== 'shape' || !child.models.every((m) => m.modelId === modelId)) continue;
      moves.push({ node: n, before: n.frames, after: n.frames.map((f) => ({ ...f, attrs: undefined, translation: f.translation.map((v, i) => v + applyRot(f.rotation, shift)[i]) as V3 })) });
    }
    const set = (model: typeof old, which: 'before' | 'after') => {
      file.models[modelId] = model;
      for (const m of moves) m.node.frames = m[which];
      this.host.structureChanged();
    };
    this.history.run({ label, apply: () => set(next, 'after'), revert: () => set(old, 'before') });
    return { size: ns, voxels: kept.length / 4, cut: old.voxels.length / 4 - kept.length / 4 };
  }

  /** Rename, hide or show an object, or put it on another layer. */
  setObject(nodeId: number, change: { name?: string; hidden?: boolean; layer?: number }, label = 'Object') {
    const node = this.transform(nodeId);
    const before = { attrs: { ...node.attrs }, layerId: node.layerId };
    const attrs = { ...node.attrs };
    if (change.name !== undefined) { if (change.name) attrs._name = change.name; else delete attrs._name; }
    if (change.hidden !== undefined) { if (change.hidden) attrs._hidden = '1'; else delete attrs._hidden; }
    const layerId = change.layer ?? node.layerId;
    if (change.layer !== undefined && !this.host.file!.layers.has(change.layer)) throw new Error(`No layer ${change.layer}`);
    const set = (a: VoxDict, l: number) => {
      node.attrs = a;
      node.layerId = l;
      this.host.structureChanged();
    };
    this.history.run({ label, apply: () => set(attrs, layerId), revert: () => set(before.attrs, before.layerId) });
  }

  /** Rename, hide or show a layer (MagicaVoxel's 16 layers). */
  setLayer(layerId: number, change: { name?: string; hidden?: boolean }, label = `Layer ${layerId}`) {
    const file = this.host.file!;
    const before = file.layers.get(layerId) ?? { id: layerId, attrs: {}, hidden: false };
    const attrs = { ...before.attrs };
    if (change.name !== undefined) { if (change.name) attrs._name = change.name; else delete attrs._name; }
    if (change.hidden !== undefined) attrs._hidden = change.hidden ? '1' : '0';
    const after = { id: layerId, attrs, hidden: attrs._hidden === '1' };
    const existed = file.layers.has(layerId);
    const set = (l: typeof before | null) => {
      if (l) file.layers.set(layerId, l);
      else file.layers.delete(layerId);
      this.host.structureChanged();
    };
    this.history.run({ label, apply: () => set(after), revert: () => set(existed ? before : null) });
  }

  /** The group directly holding a node, if any. */
  parentGroup(nodeId: number): GroupNode | null {
    for (const n of this.host.file!.nodes.values()) if (n.kind === 'group' && n.childIds.includes(nodeId)) return n;
    return null;
  }

  /** The scene's top group (under root transform 0). */
  private rootGroup(): GroupNode {
    const file = this.host.file!;
    const root = file.nodes.get(0);
    const g = root?.kind === 'transform' ? file.nodes.get(root.childId) : undefined;
    if (g?.kind !== 'group') throw new Error('This file has no scene group.');
    return g;
  }

  /** A transform and everything below it, in depth-first order. */
  subtree(nodeId: number): SceneNode[] {
    const file = this.host.file!;
    const out: SceneNode[] = [];
    const visit = (id: number) => {
      const n = file.nodes.get(id);
      if (!n || out.includes(n)) return;
      out.push(n);
      if (n.kind === 'transform') visit(n.childId);
      else if (n.kind === 'group') n.childIds.forEach(visit);
    };
    visit(nodeId);
    return out;
  }

  /**
   * Add copies of `nodes` (a subtree whose first node is a transform) with fresh node ids and
   * copies of their models, under `parent`. Returns the new root's id. Not undoable on its own.
   */
  private insertCopy(nodes: SceneNode[], models: Map<number, VoxModel>, parent: GroupNode, place: (f: TransformFrame[]) => TransformFrame[]): { root: number; nodeIds: number[]; modelIds: number[] } {
    const file = this.host.file!;
    let next = Math.max(-1, ...file.nodes.keys()) + 1;
    const ids = new Map(nodes.map((n) => [n.id, next++]));
    const modelIds = new Map<number, number>();
    for (const [old, m] of models) {
      modelIds.set(old, file.models.length);
      file.models.push({ size: [...m.size] as V3, voxels: m.voxels.slice() });
    }
    nodes.forEach((n, i) => {
      const id = ids.get(n.id)!;
      if (n.kind === 'transform') {
        const frames = n.frames.map((f) => ({ ...f, attrs: undefined }));
        file.nodes.set(id, { ...n, id, attrs: { ...n.attrs }, childId: ids.get(n.childId) ?? -1, frames: i === 0 ? place(frames) : frames });
      } else if (n.kind === 'group') {
        file.nodes.set(id, { ...n, id, attrs: { ...n.attrs }, childIds: n.childIds.map((c) => ids.get(c)!).filter((c) => c !== undefined) });
      } else {
        file.nodes.set(id, { ...n, id, attrs: { ...n.attrs }, models: n.models.map((m) => ({ ...m, attrs: undefined, modelId: modelIds.get(m.modelId) ?? m.modelId })) });
      }
    });
    const root = ids.get(nodes[0].id)!;
    parent.childIds.push(root);
    return { root, nodeIds: [...ids.values()], modelIds: [...modelIds.values()] };
  }

  /** Undo for insertCopy: remove the nodes, and the models if they're still the last ones. */
  private removeCopy(parent: GroupNode, made: { root: number; nodeIds: number[]; modelIds: number[] }) {
    const file = this.host.file!;
    parent.childIds = parent.childIds.filter((c) => c !== made.root);
    for (const id of made.nodeIds) file.nodes.delete(id);
    if (made.modelIds.length && made.modelIds.at(-1) === file.models.length - 1) file.models.length = made.modelIds[0];
  }

  private modelsOf(nodes: SceneNode[]) {
    const file = this.host.file!;
    const models = new Map<number, VoxModel>();
    for (const n of nodes) if (n.kind === 'shape') for (const m of n.models) if (file.models[m.modelId]) models.set(m.modelId, file.models[m.modelId]);
    return models;
  }

  /** Duplicate an object or group next to the original (its own copy of the voxels). */
  duplicate(nodeId: number, offset?: V3): number {
    const nodes = this.subtree(nodeId);
    if (nodes[0]?.kind !== 'transform') throw new Error(`No object with id ${nodeId}`);
    const parent = this.parentGroup(nodeId);
    if (!parent) throw new Error("The scene's root can't be duplicated.");
    // Default: beside the original, past its width.
    const before = this.selectionPlacementsOf(nodeId);
    let off = offset;
    if (!off) {
      const b = before.map((p) => placementBounds(this.host.file!, p));
      const w = b.length ? Math.max(...b.map((x) => x.hi[0])) - Math.min(...b.map((x) => x.lo[0])) + 1 : 8;
      off = [w + 2, 0, 0];
    }
    const o = off;
    let made: ReturnType<VoxelEditor['insertCopy']> | null = null;
    this.history.run({
      label: `Duplicate ${nodes[0].attrs._name ?? 'object'}`,
      apply: () => {
        made = this.insertCopy(nodes, this.modelsOf(nodes), parent, (fr) => fr.map((f) => ({ ...f, translation: f.translation.map((v, i) => v + o[i]) as V3 })));
        this.host.structureChanged();
        this.select(made.root);
      },
      revert: () => {
        if (made) this.removeCopy(parent, made);
        this.selected.set(nodeId);
        this.host.structureChanged();
      },
    });
    return made!.root;
  }

  private selectionPlacementsOf(nodeId: number) {
    return this.host.placements().filter((p) => p.nodeId === nodeId || p.path?.includes(nodeId));
  }

  /** Remove an object or group from the scene (its models stay until the file is saved). */
  deleteObject(nodeId: number) {
    const parent = this.parentGroup(nodeId);
    if (!parent || nodeId === 0) throw new Error("The scene's root can't be deleted.");
    const name = this.host.file!.nodes.get(nodeId)?.attrs._name ?? 'object';
    const at = parent.childIds.indexOf(nodeId);
    this.history.run({
      label: `Delete ${name}`,
      apply: () => {
        parent.childIds = parent.childIds.filter((c) => c !== nodeId);
        if (get(this.selected) === nodeId) this.selected.set(null);
        this.host.structureChanged();
      },
      revert: () => {
        parent.childIds.splice(at, 0, nodeId);
        this.host.structureChanged();
      },
    });
  }

  /** Copy an object or group to the clipboard (kept in this browser, so it pastes into other files too). */
  copy(nodeId: number): Clip {
    const clip = this.makeClip(nodeId);
    Clipboard.save(clip);
    this.host.setStatus('msg', `Copied ${clip.name}`);
    return clip;
  }

  /** An object or group as a clip (its nodes, models and colours), without touching the clipboard. */
  makeClip(nodeId: number): Clip {
    const file = this.host.file!;
    const nodes = this.subtree(nodeId);
    if (nodes[0]?.kind !== 'transform') throw new Error(`No object with id ${nodeId}`);
    const models = this.modelsOf(nodes);
    const used = new Set<number>();
    for (const m of models.values()) for (let i = 3; i < m.voxels.length; i += 4) used.add(m.voxels[i]);
    const b = this.selectionPlacementsOf(nodeId).map((p) => placementBounds(file, p));
    const clip: Clip = {
      kind: 'magic-mirror-clip',
      name: nodes[0].attrs._name ?? 'object',
      nodes: nodes.map((n) => (n.kind === 'transform' ? { ...n, frames: n.frames.map((f) => ({ ...f, attrs: undefined })) } : n.kind === 'shape' ? { ...n, models: n.models.map((m) => ({ ...m, attrs: undefined })) } : n)),
      models: [...models].map(([id, m]) => ({ id, size: m.size, voxels: toBase64(m.voxels) })),
      colors: [...used].map((i) => ({ index: i, rgba: Array.from(file.palette.subarray(i * 4, i * 4 + 4)), material: file.materials.get(i) })),
      bottom: b.length ? Math.min(...b.map((x) => x.lo[2])) : 0,
      center: b.length ? ([0, 1].map((i) => Math.round((Math.min(...b.map((x) => x.lo[i])) + Math.max(...b.map((x) => x.hi[i]))) / 2)) as [number, number]) : [0, 0],
      extent: b.length ? ([0, 1].map((i) => Math.max(...b.map((x) => x.hi[i])) - Math.min(...b.map((x) => x.lo[i])) + 1) as [number, number]) : [8, 8],
    };
    return clip;
  }

  /**
   * Paste the clipboard into the top group, centred at (x, y) with its bottom on the ground.
   * Colours keep their look: an index whose colour differs here is mapped to a matching or free
   * palette slot (taking its material along).
   */
  paste(at: [number, number], clip = Clipboard.load(), bottom?: number): number | null {
    if (!clip) return null;
    const file = this.host.file!;
    const parent = this.rootGroup();
    // Colour mapping: keep an index whose colour already matches, reuse an exact match elsewhere,
    // and put the rest in free slots, side by side when possible so a block of colours (all the
    // terrain, say) stays a block in this palette too.
    const same = (i: number, rgba: number[]) => rgba.every((v, k) => file.palette[i * 4 + k] === v);
    const usedHere = new Set<number>();
    for (const m of file.models) for (let i = 3; i < m.voxels.length; i += 4) usedHere.add(m.voxels[i]);
    const remap = new Map<number, number>();
    const newColors: { index: number; rgba: number[]; material?: VoxDict }[] = [];
    const homeless: typeof clip.colors = [];
    for (const c of [...clip.colors].sort((a, b) => a.index - b.index)) {
      if (same(c.index, c.rgba)) continue;
      let to = -1;
      for (let i = 1; i < 256 && to < 0; i++) if (same(i, c.rgba)) to = i;
      if (to >= 0) remap.set(c.index, to);
      else homeless.push(c);
    }
    const isFree = (i: number) => !usedHere.has(i) && !remap.has(i) && ![...remap.values()].includes(i);
    let run = -1;
    for (let start = 1; start + homeless.length <= 256 && run < 0 && homeless.length; start++) {
      let ok = true;
      for (let k = 0; k < homeless.length && ok; k++) ok = isFree(start + k);
      if (ok) run = start;
    }
    homeless.forEach((c, k) => {
      let to = run >= 0 ? run + k : -1;
      for (let i = 1; i < 256 && to < 0; i++) if (isFree(i) && !newColors.some((n) => n.index === i)) to = i;
      if (to < 0) to = c.index; // palette full: keep the index
      if (to !== c.index) remap.set(c.index, to);
      newColors.push({ index: to, rgba: c.rgba, material: c.material });
      usedHere.add(to);
    });
    const models = new Map<number, VoxModel>();
    for (const m of clip.models) {
      const v = Uint8Array.from(atob(m.voxels), (ch) => ch.charCodeAt(0));
      for (let i = 3; i < v.length; i += 4) v[i] = remap.get(v[i]) ?? v[i];
      models.set(m.id, { size: m.size as V3, voxels: v });
    }
    const ground = bottom ?? this.host.grid?.origin[2] ?? 0;
    // Pasting where it came from would hide it inside the original: put it alongside instead.
    if (bottom === undefined && Math.abs(at[0] - clip.center[0]) < 2 && Math.abs(at[1] - clip.center[1]) < 2) at = [at[0] + (clip.extent?.[0] ?? 8) + 2, at[1]];
    const shift: V3 = [Math.round(at[0]) - clip.center[0], Math.round(at[1]) - clip.center[1], ground - clip.bottom];
    const oldColors = newColors.map((c) => ({ index: c.index, rgba: Array.from(file.palette.subarray(c.index * 4, c.index * 4 + 4)), material: file.materials.get(c.index) }));
    const setColors = (list: typeof newColors) => {
      for (const c of list) {
        file.palette.set(c.rgba, c.index * 4);
        if (c.material) file.materials.set(c.index, c.material);
        else file.materials.delete(c.index);
      }
      if (list.length) this.host.materialsChanged();
    };
    let made: ReturnType<VoxelEditor['insertCopy']> | null = null;
    this.history.run({
      label: `${clip.kind === 'magic-mirror-clip' && clip.fromLibrary ? 'Place' : 'Paste'} ${clip.name}`,
      apply: () => {
        setColors(newColors);
        made = this.insertCopy(clip.nodes as SceneNode[], models, parent, (fr) => fr.map((f) => ({ ...f, translation: f.translation.map((v, i) => v + shift[i]) as V3 })));
        this.host.structureChanged();
        this.select(made.root);
      },
      revert: () => {
        if (made) this.removeCopy(parent, made);
        setColors(oldColors);
        this.selected.set(null);
        this.host.structureChanged();
      },
    });
    if (remap.size) this.host.setStatus('msg', `Pasted ${clip.name}; ${remap.size} colour${remap.size > 1 ? 's' : ''} moved to free palette slots`);
    return made!.root;
  }

  /** Run several edits as one undo step. */
  group(label: string, fn: () => void) {
    const start = this.history.size;
    fn();
    this.history.squash(start, label);
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

  /** What's under a point of the render (u, v in 0..1): a voxel, or the ground. */
  pickAt(u: number, v: number, aspect: number): GridHit | null {
    const r = this.ray(u, v, aspect);
    return r && this.host.grid ? castRay(this.host.grid, r.origin, r.dir) : null;
  }

  /** Which placed model owns a world voxel (the last one drawn there, like the baker). */
  ownerOf(cell: V3): PlacedModel | null {
    const file = this.host.file!;
    const ps = this.host.placements();
    for (let i = ps.length - 1; i >= 0; i--) {
      const l = worldToModel(file, ps[i], cell);
      if (this.volume(ps[i].modelId).get(...l)) return ps[i];
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
    if (mode !== 'attach' && (hit.ground || this.ownerOf(hit.cell)?.nodeId !== p.nodeId)) return [];
    const start = worldToModel(file, p, base);
    if (brush === 'box' && boxEnd) {
      const end = worldToModel(file, p, boxEnd);
      const lo = start.map((v, i) => Math.max(0, Math.min(v, end[i]))), hi = start.map((v, i) => Math.min(vol.size[i] - 1, Math.max(v, end[i])));
      const out: V3[] = [];
      for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) out.push([x, y, z]);
      return out;
    }
    if ((brush === 'line' || brush === 'sphere') && boxEnd) {
      const end = worldToModel(file, p, boxEnd);
      const cells = brush === 'line'
        ? shapeCells({ shape: 'line', from: start, to: end })
        : shapeCells({ shape: 'sphere', center: start, radius: Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]) });
      return cells.filter((c) => vol.inside(...c));
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
  pointerDown(u: number, v: number, aspect: number, e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey?: boolean }): boolean {
    if (!get(this.enabled) || !this.host.grid) return false;
    const r = this.ray(u, v, aspect);
    if (!r) return true;
    const hit = castRay(this.host.grid, r.origin, r.dir);
    if (e.altKey) {
      // Eyedropper.
      if (hit && !hit.ground) {
        const c = this.host.grid.getWorld(...hit.cell);
        if (c) this.color.set(c);
      }
      return true;
    }
    const owner = hit && !hit.ground ? this.ownerOf(hit.cell) : null;
    const mode = get(this.mode), brush = get(this.brush);
    // Ctrl+click picks another model; with nothing picked, a click picks (Move picks and drags).
    if (e.ctrlKey || e.metaKey || (get(this.selected) === null && mode !== 'move')) {
      if (owner?.nodeId !== undefined) this.select(owner.nodeId);
      this.hover(u, v, aspect);
      return true;
    }
    if (mode === 'move') {
      // Clicking part of the selected group keeps the group; anything else selects that object.
      const sel = get(this.selected);
      if (owner?.nodeId !== undefined && owner.nodeId !== sel && !(sel !== null && owner.path?.includes(sel))) this.select(owner.nodeId);
      const nodeId = get(this.selected);
      if (nodeId === null || !this.selectionPlacements().length) return true;
      // Drag on the horizontal plane through the clicked point; with Shift, up and down.
      const t = hit ? hit.t : 0;
      const at = [0, 1, 2].map((i) => r.origin[i] + r.dir[i] * t) as V3;
      let axis = 2, plane = hit ? at[2] : this.host.grid.origin[2];
      if (e.shiftKey) {
        const cam = this.host.cameraFrame()!;
        axis = Math.abs(cam.forward[0]) > Math.abs(cam.forward[1]) ? 0 : 1;
        plane = at[axis];
      }
      const from = planeCell(r.origin, r.dir, axis, plane);
      if (from) this.moving = { nodeId, axis, plane, from, delta: [0, 0, 0] };
      return true;
    }
    const p = this.selectedPlacement();
    if (!p || !hit) return true;
    const names = { attach: 'Attach', erase: 'Erase', paint: 'Paint', move: 'Move' };
    this.stroke = { modelId: p.modelId, diff: new Map(), label: `${names[mode]} (${brush})` };
    const base: V3 = mode === 'attach' ? [hit.cell[0] + hit.normal[0], hit.cell[1] + hit.normal[1], hit.cell[2] + hit.normal[2]] : hit.cell;
    const axis = hit.normal.findIndex((x) => x !== 0);
    this.stroke.start = { cell: base, axis, plane: base[axis] + 0.5, hit };
    if (!DRAG_BRUSHES.includes(brush)) this.addToStroke(this.targets(p, hit, mode, brush));
    else this.preview.set({ boxes: [...this.modelBox(), { min: base, max: base, kind: 'target' }] });
    return true;
  }

  pointerMove(u: number, v: number, aspect: number) {
    const r = this.ray(u, v, aspect);
    if (this.moving && r) {
      const m = this.moving;
      const now = planeCell(r.origin, r.dir, m.axis, m.plane);
      if (!now) return;
      m.delta = m.axis === 2 ? [now[0] - m.from[0], now[1] - m.from[1], 0] : [0, 0, now[2] - m.from[2]];
      const box = this.modelBox()[0];
      if (box) this.preview.set({ boxes: [box, { min: box.min.map((x, i) => x + m.delta[i]) as V3, max: box.max.map((x, i) => x + m.delta[i]) as V3, kind: 'target' }] });
      this.host.setStatus('msg', `Move by ${m.delta.join(', ')}`);
      return;
    }
    if (!this.stroke) return this.hover(u, v, aspect);
    const p = this.selectedPlacement(), st = this.stroke.start;
    if (!p || !r || !st) return;
    const mode = get(this.mode), brush = get(this.brush);
    if (DRAG_BRUSHES.includes(brush) || (brush === 'voxel' && mode === 'attach')) {
      // Stay on the plane the stroke started on, so attaching doesn't climb towards the camera.
      const end = planeCell(r.origin, r.dir, st.axis, st.plane);
      if (!end) return;
      if (DRAG_BRUSHES.includes(brush)) {
        this.stroke.end = end;
        const cells = this.mirrored(p.modelId, this.targets(p, st.hit, mode, brush, end)).slice(0, 20000).map((c) => this.toWorld(p, c));
        const boxes: Preview['boxes'] = [...this.modelBox()];
        if (brush === 'line' && cells.length <= 512) for (const c of cells) boxes.push({ min: c, max: c, kind: 'target' });
        else if (cells.length) boxes.push({ min: [0, 1, 2].map((i) => Math.min(...cells.map((c) => c[i]))) as V3, max: [0, 1, 2].map((i) => Math.max(...cells.map((c) => c[i]))) as V3, kind: 'target' });
        this.preview.set({ boxes });
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
    if (this.moving) {
      const m = this.moving;
      this.moving = null;
      if (m.delta.some((d) => d !== 0)) this.moveObject(m.nodeId, m.delta, `Move ${this.host.file?.nodes.get(m.nodeId)?.attrs._name ?? 'object'} by ${m.delta.join(', ')}`);
      this.preview.set({ boxes: this.modelBox() });
      return;
    }
    const st = this.stroke;
    if (!st) return;
    const p = this.selectedPlacement();
    const brush = get(this.brush);
    if (DRAG_BRUSHES.includes(brush) && p && st.start) this.addToStroke(this.targets(p, st.start.hit, get(this.mode), brush, st.end ?? st.start.cell));
    this.stroke = null;
    for (const [i, [a, b]] of st.diff) if (a === b) st.diff.delete(i);
    if (st.diff.size) {
      // Already applied while drawing; record it for undo.
      this.history.push(this.diffCommand(st.modelId, st.diff, `${st.label}: ${st.diff.size} voxels`));
    }
    this.preview.set({ boxes: this.modelBox() });
  }

  private modelBox(): Preview['boxes'] {
    const ps = this.selectionPlacements();
    if (!ps.length || !this.host.file) return [];
    const bs = ps.map((p) => placementBounds(this.host.file!, p));
    return [{ min: [0, 1, 2].map((i) => Math.min(...bs.map((b) => b.lo[i]))) as V3, max: [0, 1, 2].map((i) => Math.max(...bs.map((b) => b.hi[i]))) as V3, kind: 'model' }];
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
        if (owner) {
          const b = placementBounds(this.host.file!, owner);
          boxes.push({ min: b.lo as V3, max: b.hi as V3, kind: 'target' });
        }
      } else if (get(this.mode) === 'move') {
        const owner = hit.ground ? null : this.ownerOf(hit.cell);
        if (owner && owner.nodeId !== p.nodeId && !owner.path?.includes(get(this.selected)!)) {
          const b = placementBounds(this.host.file!, owner);
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
