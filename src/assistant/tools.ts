// Runs the assistant's tools (defined in toolDefs.ts) against the app. Every scene change goes
// through app.editor / app.history, so it shows in the undo history and can be undone.

import { get } from 'svelte/store';
import type { App } from '../app';
import { decodeRotation, IDENTITY_ROT } from '../vox/parser';
import { animationLength, placementBounds } from '../vox/scene';
import type { Rot3, TransformFrame } from '../vox/types';
import type { SettingValue } from '../core/settings';
import { captureKey, getKeys, withKey, type CameraKey } from '../anim/camera';
import { setCameraKeys, setTimelineEnd } from '../edit/cameraKeys';

type V3 = [number, number, number];
export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolOutput {
  content: McpContent[];
  isError?: boolean;
}

const text = (v: unknown): ToolOutput => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] });
const hex = (p: Uint8Array, i: number) => '#' + Array.from(p.subarray(i * 4, i * 4 + 3), (v) => v.toString(16).padStart(2, '0')).join('');
const ROT_Z: Record<number, number> = { 0: 4, 90: 17, 180: 52, 270: 33 };

function rotZ(deg: number | undefined): Rot3 {
  if (deg === undefined) return IDENTITY_ROT;
  const d = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return decodeRotation(ROT_Z[d]);
}
function zOf(r: Rot3): number {
  for (const [deg, b] of Object.entries(ROT_Z)) if (decodeRotation(b).every((v, i) => v === r[i])) return Number(deg);
  return -1; // not a pure Z rotation
}

function need(app: App) {
  if (!app.file || !app.grid) throw new Error('No scene is open. Ask the user to open a .vox, or press New.');
  return app.file;
}

function sceneSummary(app: App) {
  const file = need(app);
  const grid = app.grid!;
  const placed = app.editor.host.placements();
  const objects = placed.slice(0, 400).map((p) => {
    const node = p.nodeId !== undefined ? file.nodes.get(p.nodeId) : undefined;
    const keys = node?.kind === 'transform' ? node.frames.filter((f) => f.frame !== undefined) : [];
    const b = placementBounds(file, p);
    return {
      object_id: p.nodeId,
      name: p.name,
      model_id: p.modelId,
      size: file.models[p.modelId].size,
      voxels: file.models[p.modelId].voxels.length / 4,
      position: p.translation,
      rotation_z: zOf(p.rotation),
      world_bounds: [b.lo, b.hi],
      keyframes: keys.length ? keys.map((k) => [k.frame, ...k.translation]) : undefined,
    };
  });
  const used = new Map<number, number>();
  for (const m of file.models) for (let i = 3; i < m.voxels.length; i += 4) used.set(m.voxels[i], (used.get(m.voxels[i]) ?? 0) + 1);
  const unused: number[] = [];
  for (let i = 1; i < 256 && unused.length < 40; i++) if (!used.has(i)) unused.push(i);
  const s = app.settings;
  return {
    file: app.fileName,
    voxels: grid.voxelCount,
    world_bounds: [grid.origin, grid.origin.map((v, i) => v + grid.dims[i] - 1)],
    ground_height: grid.origin[2],
    animation: { last_frame: app.animationEnd(), scene_keyframes_end: animationLength(file), current_frame: s.num('anim.frame'), fps: s.num('anim.fps') },
    camera_keyframes: getKeys(s),
    objects,
    objects_listed: `${objects.length} of ${placed.length}`,
    palette_in_use: [...used.entries()].sort((a, b) => b[1] - a[1]).map(([i, n]) => ({ index: i, hex: hex(file.palette, i), voxels: n, material: file.materials.get(i)?._type?.slice(1) ?? 'diffuse' })),
    unused_palette_slots: unused,
    camera: {
      projection: s.str('cam.projection'), target: s.vec('cam.target'), yaw: s.num('cam.yaw'), pitch: s.num('cam.pitch'),
      distance: s.num('cam.distance'), fov: s.num('cam.fov'), ortho_size: s.num('cam.orthoSize'),
    },
    editor: { editing_model: app.editor.selectedPlacement()?.modelId ?? null, colour: get(app.editor.color) },
  };
}

interface Shape {
  shape: 'box' | 'sphere' | 'cylinder' | 'line';
  from?: V3; to?: V3; center?: V3; radius?: number; height?: number;
  color?: number; mode?: 'set' | 'add' | 'paint' | 'erase'; hollow?: boolean;
}

/** Cells (model coordinates, unclipped) covered by a shape. */
function shapeCells(sh: Shape): V3[] {
  let lo: V3, hi: V3, inside: (x: number, y: number, z: number) => boolean;
  const r = Math.max(0, sh.radius ?? 0);
  if (sh.shape === 'box') {
    const a = sh.from ?? [0, 0, 0], b = sh.to ?? a;
    lo = a.map((v, i) => Math.round(Math.min(v, b[i]))) as V3;
    hi = a.map((v, i) => Math.round(Math.max(v, b[i]))) as V3;
    inside = (x, y, z) => x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2];
  } else if (sh.shape === 'sphere') {
    const c = sh.center ?? [0, 0, 0], rr = (r + 0.5) ** 2;
    lo = c.map((v) => Math.floor(v - r - 1)) as V3;
    hi = c.map((v) => Math.ceil(v + r + 1)) as V3;
    inside = (x, y, z) => (x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2 <= rr;
  } else if (sh.shape === 'cylinder') {
    const c = sh.center ?? [0, 0, 0], h = Math.max(1, Math.round(sh.height ?? 1)), rr = (r + 0.5) ** 2;
    lo = [Math.floor(c[0] - r - 1), Math.floor(c[1] - r - 1), Math.round(c[2])];
    hi = [Math.ceil(c[0] + r + 1), Math.ceil(c[1] + r + 1), Math.round(c[2]) + h - 1];
    inside = (x, y, z) => z >= lo[2] && z <= hi[2] && (x - c[0]) ** 2 + (y - c[1]) ** 2 <= rr;
  } else {
    const a = sh.from ?? [0, 0, 0], b = sh.to ?? a, rr = (r + 0.5) ** 2;
    const d = b.map((v, i) => v - a[i]), len2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1;
    lo = a.map((v, i) => Math.floor(Math.min(v, b[i]) - r - 1)) as V3;
    hi = a.map((v, i) => Math.ceil(Math.max(v, b[i]) + r + 1)) as V3;
    inside = (x, y, z) => {
      const t = Math.max(0, Math.min(1, ((x - a[0]) * d[0] + (y - a[1]) * d[1] + (z - a[2]) * d[2]) / len2));
      return (x - a[0] - d[0] * t) ** 2 + (y - a[1] - d[1] * t) ** 2 + (z - a[2] - d[2] * t) ** 2 <= Math.max(rr, 0.75);
    };
  }
  const vol = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
  if (vol > 20_000_000) throw new Error(`A ${sh.shape} that big (${vol.toLocaleString()} cells) is too large.`);
  const out: V3[] = [];
  for (let z = lo[2]; z <= hi[2]; z++)
    for (let y = lo[1]; y <= hi[1]; y++)
      for (let x = lo[0]; x <= hi[0]; x++) {
        if (!inside(x, y, z)) continue;
        if (sh.hollow && inside(x + 1, y, z) && inside(x - 1, y, z) && inside(x, y + 1, z) && inside(x, y - 1, z) && inside(x, y, z + 1) && inside(x, y, z - 1)) continue;
        out.push([x, y, z]);
      }
  return out;
}

async function renderPreview(app: App, samples: number, maxSize: number): Promise<ToolOutput> {
  need(app);
  const r = app.renderer;
  const target = Math.min(samples, app.settings.num('rt.maxSamples'));
  const start = performance.now();
  // Wait for the progressive render to get there (it restarts after every change).
  await new Promise((ok) => setTimeout(ok, 50));
  while (r.samples < target && performance.now() - start < 90_000) await new Promise((ok) => setTimeout(ok, 100));
  const png = await app.renderPng();
  const bmp = await createImageBitmap(png);
  const k = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const small = await new Promise<Blob>((ok) => c.toBlob((b) => ok(b!), 'image/png'));
  const bytes = new Uint8Array(await small.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {
    content: [
      { type: 'image', data: btoa(bin), mimeType: 'image/png' },
      { type: 'text', text: `${c.width}×${c.height}, ${r.samples} samples, frame ${app.settings.num('anim.frame')}` },
    ],
  };
}

type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Run one tool. Throws on bad input; the caller turns that into an error result. */
export async function runTool(app: App, name: string, a: Args): Promise<ToolOutput> {
  const ed = app.editor;
  const label = (s: string) => `Claude: ${s}`;
  switch (name) {
    case 'get_scene':
      return text(sceneSummary(app));

    case 'get_model': {
      const file = need(app);
      const m = file.models[a.model_id];
      if (!m) throw new Error(`No model ${a.model_id}`);
      const max = Math.min(50000, a.max_voxels ?? 5000);
      const v: number[][] = [];
      for (let i = 0; i < m.voxels.length && v.length < max; i += 4) v.push([m.voxels[i], m.voxels[i + 1], m.voxels[i + 2], m.voxels[i + 3]]);
      return text({ model_id: a.model_id, size: m.size, voxel_count: m.voxels.length / 4, voxels: v, truncated: m.voxels.length / 4 > v.length });
    }

    case 'set_voxels': {
      need(app);
      const n = ed.setVoxels(a.model_id, a.voxels ?? [], label(a.label ?? 'set voxels'));
      return text(`Changed ${n} voxels.`);
    }

    case 'draw_shapes': {
      const file = need(app);
      if (!file.models[a.model_id]) throw new Error(`No model ${a.model_id}`);
      const vol = ed.volume(a.model_id);
      const pending = new Map<number, number>(); // cell index -> colour, so later shapes see earlier ones
      const at = (i: number) => pending.get(i) ?? vol.cells[i];
      let clipped = 0;
      for (const sh of (a.shapes ?? []) as Shape[]) {
        const mode = sh.mode ?? 'set';
        const c = mode === 'erase' ? 0 : Math.max(1, Math.min(255, Math.round(sh.color ?? get(ed.color))));
        for (const [x, y, z] of shapeCells(sh)) {
          if (!vol.inside(x, y, z)) { clipped++; continue; }
          const i = vol.index(x, y, z);
          if (mode === 'add' && at(i)) continue;
          if (mode === 'paint' && !at(i)) continue;
          pending.set(i, c);
        }
      }
      const [sx, sy] = vol.size;
      const list = [...pending].map(([i, c]) => [i % sx, Math.floor(i / sx) % sy, Math.floor(i / (sx * sy)), c] as [number, number, number, number]);
      const n = ed.setVoxels(a.model_id, list, label(a.label ?? `draw ${(a.shapes ?? []).map((s: Shape) => s.shape).join(', ')}`));
      return text(`Changed ${n} voxels${clipped ? `; ${clipped} cells fell outside the ${vol.size.join('×')} model and were skipped` : ''}.`);
    }

    case 'add_model': {
      need(app);
      const before = new Set(ed.host.placements().map((p) => p.nodeId));
      const modelId = ed.addModel(a.size, a.position, a.name ?? 'model');
      app.history.squash(app.history.size - 1, label(`new model "${a.name ?? 'model'}"`));
      const p = ed.host.placements().find((q) => q.modelId === modelId && !before.has(q.nodeId));
      return text({ model_id: modelId, object_id: p?.nodeId, size: app.file!.models[modelId].size });
    }

    case 'move_object': {
      need(app);
      ed.setTransform(a.object_id, [{ rotation: rotZ(a.rotation_z), translation: a.position.map(Math.round) }], label('move object'));
      return text('Moved.');
    }

    case 'set_object_animation': {
      need(app);
      const keys = [...(a.keyframes ?? [])].sort((p, q) => p.frame - q.frame);
      if (!keys.length) throw new Error('Give at least one keyframe.');
      const frames: TransformFrame[] = keys.map((k) => ({ frame: Math.max(0, Math.round(k.frame)), rotation: rotZ(k.rotation_z), translation: k.position.map(Math.round) }));
      ed.setTransform(a.object_id, frames, label(`animate object (${frames.length} keys)`));
      return text(`Set ${frames.length} keyframes; the animation now ends at frame ${app.animationEnd()}.`);
    }

    case 'set_palette': {
      need(app);
      ed.group(label('palette colours'), () => {
        for (const { index, hex: h } of a.colors ?? []) {
          const m = /^#?([0-9a-f]{6})$/i.exec(String(h));
          if (!m || index < 1 || index > 255) throw new Error(`Bad colour ${index}: ${h}`);
          const n = parseInt(m[1], 16);
          ed.setColor(index, [n >> 16, (n >> 8) & 255, n & 255, 255]);
        }
      });
      return text(`Set ${(a.colors ?? []).length} colours.`);
    }

    case 'set_material': {
      need(app);
      const d: Record<string, string> = { _type: `_${a.type}` };
      for (const [k, v] of Object.entries(a.properties ?? {})) d[`_${k.replace(/^_/, '')}`] = String(v);
      ed.setMaterial(a.index, d, label(`material ${a.index}: ${a.type}`));
      return text('Material set.');
    }

    case 'list_settings': {
      const out = app.settings.groups.flatMap((g) =>
        g.defs
          .filter((d) => !a.group || d.key.startsWith(a.group) || g.id === a.group)
          .map((d) => ({
            key: d.key, label: d.label, type: d.type, value: app.settings.get(d.key),
            ...(d.type === 'number' ? { min: d.min, max: d.max } : {}),
            ...(d.type === 'select' ? { options: d.options.map((o) => o.value) } : {}),
            ...(d.help ? { help: d.help } : {}),
          })),
      );
      return text(out);
    }

    case 'set_settings': {
      const s = app.settings;
      const values = (a.values ?? {}) as Record<string, SettingValue>;
      const unknown = Object.keys(values).filter((k) => !s.def(k));
      const known = Object.keys(values).filter((k) => s.def(k));
      const before = Object.fromEntries(known.map((k) => [k, structuredClone(s.get(k))]));
      if (known.length)
        app.history.run({ label: label(`settings: ${known.join(', ')}`.slice(0, 80)), apply: () => s.apply(values), revert: () => s.apply(before) });
      return text({ changed: known, unknown_keys: unknown.length ? unknown : undefined });
    }

    case 'set_camera_keyframes': {
      need(app);
      const st = app.settings;
      let keys: CameraKey[] = a.replace === false ? getKeys(st) : [];
      const sorted = [...(a.keyframes ?? [])].sort((p, q) => p.frame - q.frame);
      for (const k of sorted) {
        // Anything left out comes from the previous key, or the current camera for the first.
        const prev = [...keys].reverse().find((x) => x.frame <= k.frame) ?? captureKey(st, k.frame);
        keys = withKey(keys, {
          frame: Math.max(0, Math.round(k.frame)),
          target: (k.target ?? prev.target).map(Number) as [number, number, number],
          yaw: k.yaw ?? prev.yaw, pitch: k.pitch ?? prev.pitch, distance: k.distance ?? prev.distance,
          fov: k.fov ?? prev.fov, orthoSize: k.ortho_size ?? prev.orthoSize, ease: k.ease ?? 'smooth',
        });
      }
      setCameraKeys(app, keys, label(keys.length ? `camera keys (${keys.length})` : 'remove camera keys'));
      if (a.end_frame !== undefined) setTimelineEnd(app, a.end_frame, label(`timeline end ${a.end_frame}`));
      app.settings.set('anim.frame', app.settings.num('anim.frame')); // show the keyed camera now
      return text({ camera_keyframes: keys.length, timeline_end: app.animationEnd() });
    }

    case 'set_frame':
      app.settings.set('anim.frame', Math.max(0, Math.round(a.frame)));
      return text(`Showing frame ${app.settings.num('anim.frame')}.`);

    case 'render_preview':
      return renderPreview(app, Math.max(1, a.samples ?? 32), Math.max(64, a.max_size ?? 640));

    case 'undo': {
      const done: string[] = [];
      for (let i = 0; i < Math.max(1, a.steps ?? 1); i++) {
        const l = app.history.undo();
        if (!l) break;
        done.push(l);
      }
      return text(done.length ? { undone: done } : 'Nothing to undo.');
    }

    case 'save_vox':
      need(app);
      app.saveVox();
      return text(`Downloaded ${app.fileName} in the browser.`);

    case 'render_on_farm': {
      const file = need(app);
      void file;
      const last = app.animationEnd();
      const { farmMessage, sendJob } = await import('../features/farmClient');
      await sendJob(app, { firstFrame: a.first_frame ?? 0, lastFrame: a.last_frame ?? last, samples: a.samples ?? 256, scale: a.scale ?? 1 });
      return text(get(farmMessage) || 'Sent.');
    }
  }
  throw new Error(`Unknown tool ${name}`);
}
