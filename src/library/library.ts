// The asset library: the starter set that ships with Magic Mirror (public/library, plain .vox
// files) and "My assets" saved from your scenes (kept in this browser's IndexedDB). Placing an
// asset pastes it like the clipboard does, keeping its colours (see VoxelEditor.paste).

import { get, writable } from 'svelte/store';
import type { App } from '../app';
import { clipFromVox, fileFromClip, type Clip } from '../edit/clipboard';
import { parseVox } from '../vox/parser';
import { serializeVox } from '../vox/serialize';
import { isoThumbnail } from './thumbnail';

export interface Asset {
  id: string;
  name: string;
  category: string;
  description?: string;
  tags?: string[];
  size?: number[];
  source: 'starter' | 'mine';
  file?: string;
}

export const assets = writable<Asset[]>([]);
export const libraryError = writable('');
const clips = new Map<string, Clip>();
const thumbs = new Map<string, string>();

// ---- My assets (IndexedDB) --------------------------------------------------------------------
const DB = 'magic-mirror-library';
function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('assets', { keyPath: 'id' });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((ok, fail) => {
    const r = fn(d.transaction('assets', mode).objectStore('assets'));
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
interface Saved extends Asset { clip: Clip; created: number }

/** Load the starter set and my assets. */
export async function loadLibrary() {
  const list: Asset[] = [];
  try {
    const index = await (await fetch(new URL('library/index.json', document.baseURI))).json();
    for (const a of index.assets) list.push({ ...a, source: 'starter' });
  } catch {
    libraryError.set("Couldn't load the starter library.");
  }
  try {
    const mine = (await store('readonly', (s) => s.getAll())) as Saved[];
    for (const m of mine.sort((a, b) => b.created - a.created)) {
      clips.set(m.id, m.clip);
      list.push({ id: m.id, name: m.name, category: m.category, description: m.description, size: m.size, source: 'mine' });
    }
  } catch {
    /* no IndexedDB (private mode): starter set only */
  }
  assets.set(list);
}

export async function clipFor(a: Asset): Promise<Clip> {
  let c = clips.get(a.id);
  if (!c) {
    const bytes = new Uint8Array(await (await fetch(new URL(`library/${a.file}`, document.baseURI))).arrayBuffer());
    c = clipFromVox(parseVox(bytes), a.name);
    clips.set(a.id, c);
  }
  return { ...c, name: a.name, fromLibrary: true };
}

export async function thumbnail(a: Asset): Promise<string> {
  const t = thumbs.get(a.id);
  if (t) return t;
  const url = isoThumbnail(fileFromClip(await clipFor(a)));
  thumbs.set(a.id, url);
  return url;
}

/**
 * Put an asset in the scene, centred at (x, y). `bottom` is the z its base sits at (default: the
 * ground). Returns the new object's id.
 */
export async function place(app: App, a: Asset, at: [number, number], bottom?: number, quarterTurns = 0): Promise<number | null> {
  if (!app.file) app.newScene(null); // building from nothing: start an empty scene
  const id = app.editor.paste(at, await clipFor(a), bottom);
  if (id !== null && quarterTurns) {
    app.editor.rotateObject(id, quarterTurns);
    app.history.squash(app.history.size - 2, `Place ${a.name}`);
  }
  return id;
}

/** Save an object or group from the scene into My assets. */
export async function saveToLibrary(app: App, nodeId: number, name: string, category = 'My assets'): Promise<Asset> {
  const clip = { ...app.editor.makeClip(nodeId), name, fromLibrary: true };
  const id = `mine-${Date.now().toString(36)}`;
  const size = clip.extent ? [...clip.extent] : undefined;
  const a: Saved = { id, name, category, size, source: 'mine', clip, created: Date.now() };
  await store('readwrite', (s) => s.put(a));
  clips.set(id, clip);
  assets.update((list) => [{ id, name, category, size, source: 'mine' }, ...list]);
  return get(assets)[0];
}

export async function removeFromLibrary(a: Asset) {
  if (a.source !== 'mine') return;
  await store('readwrite', (s) => s.delete(a.id));
  clips.delete(a.id);
  thumbs.delete(a.id);
  assets.update((list) => list.filter((x) => x.id !== a.id));
}

/** The asset as a .vox file MagicaVoxel can open. */
export async function assetVox(a: Asset): Promise<Uint8Array> {
  return serializeVox(fileFromClip(await clipFor(a)));
}
