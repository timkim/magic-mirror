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
import { shapeCells, type Shape } from '../edit/shapes';

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
      layer: node?.kind === 'transform' ? node.layerId : undefined,
      group: p.path && p.path.length > 2 ? p.path[p.path.length - 2] : undefined,
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
    layers: [...file.layers.values()].map((l) => ({ id: l.id, name: l.attrs._name ?? null, hidden: l.hidden })),
    groups: [...file.nodes.values()]
      .filter((n) => n.kind === 'transform' && n.id !== 0 && file.nodes.get(n.childId)?.kind === 'group')
      .slice(0, 200)
      .map((n) => {
        const g = file.nodes.get((n as { childId: number }).childId) as { childIds: number[] };
        return { object_id: n.id, name: n.attrs._name ?? null, members: g.childIds, position: (n as { frames: { translation: number[] }[] }).frames[0].translation };
      }),
    hidden_objects: [...file.nodes.values()].filter((n) => n.kind === 'transform' && n.attrs._hidden === '1').map((n) => ({ object_id: n.id, name: n.attrs._name ?? null })),
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

    case 'set_object': {
      need(app);
      const id = a.object_id;
      ed.group(label(`object ${id}`), () => {
        if (a.move_by) ed.moveObject(id, a.move_by);
        if (a.rotate) ed.rotateObject(id, a.rotate);
        if (a.name !== undefined || a.hidden !== undefined || a.layer !== undefined) ed.setObject(id, { name: a.name, hidden: a.hidden, layer: a.layer });
      });
      return text('Done.');
    }

    case 'duplicate_object': {
      need(app);
      const id = ed.duplicate(a.object_id, a.offset);
      app.history.squash(app.history.size - 1, label(`duplicate ${a.object_id}`));
      return text({ object_id: id });
    }

    case 'delete_object': {
      need(app);
      ed.deleteObject(a.object_id);
      app.history.squash(app.history.size - 1, label(`delete ${a.object_id}`));
      return text('Deleted.');
    }

    case 'resize_model': {
      need(app);
      return text(ed.resizeModel(a.model_id, a.size, a.offset ?? [0, 0, 0], label(`resize model ${a.model_id}`)));
    }

    case 'set_layer': {
      need(app);
      ed.setLayer(a.layer_id, { name: a.name, hidden: a.hidden }, label(`layer ${a.layer_id}`));
      return text('Done.');
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

    case 'farm_status': {
      const { farmUrl } = await import('../features/farmClient');
      let st;
      try {
        st = await (await fetch(new URL('/api/status', get(farmUrl)))).json();
      } catch {
        throw new Error("Can't reach the render farm coordinator. Is npm run farm running on the PC?");
      }
      const online = st.workers.filter((w: { online: boolean }) => w.online).length;
      return text({
        jobs: st.jobs.map((j: { name: string; status: string; done: number; total: number; rendering: number; avgFrameMs: number | null; video: string | null }) => ({
          name: j.name, status: j.status, frames_done: j.done, frames_total: j.total, rendering_now: j.rendering,
          seconds_per_frame: j.avgFrameMs ? Math.round(j.avgFrameMs / 100) / 10 : null,
          minutes_left: j.status === 'active' && j.avgFrameMs && online ? Math.round(((j.total - j.done) * j.avgFrameMs) / online / 60000) : null,
          video_ready: !!j.video,
        })),
        workers_online: st.workers.filter((w: { online: boolean }) => w.online).map((w: { name: string; framesDone: number }) => ({ name: w.name, frames_done: w.framesDone })),
      });
    }

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
