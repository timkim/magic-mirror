// The tab's side of the assistant: keeps a live connection to the bridge on this PC (the
// coordinator, `npm run farm`), runs tool calls that arrive there, and drives the chat panel.

import { get, writable } from 'svelte/store';
import type { App } from '../app';
import { farmUrl } from '../features/farmClient';
import { TOOL_DEFS } from './toolDefs';
import { runTool, type ToolOutput } from './tools';

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string; status: 'running' | 'done' | 'error'; image?: string };

export interface Message {
  role: 'user' | 'assistant';
  parts: Part[];
  /** History size before and after this reply, for "Undo this reply". */
  undoFrom?: number;
  undoTo?: number;
  /** Tool calls from another Claude app (desktop, Claude Code) rather than this panel. */
  external?: boolean;
  error?: string;
}

/** 'offline' = no coordinator; 'ready' = connected; 'no-claude' = connected but Claude Code is missing. */
export const bridge = writable<{ state: 'connecting' | 'offline' | 'ready' | 'no-claude'; claude?: string }>({ state: 'connecting' });
export const messages = writable<Message[]>([]);
export const busy = writable(false);
let session: string | null = null;
const tabId = crypto.randomUUID();

const api = (path: string, init?: RequestInit) => fetch(new URL(path, get(farmUrl)), init);

const short = (name: string, args: Record<string, unknown>) => {
  const a = args as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (name) {
    case 'draw_shapes': return `${(a.shapes ?? []).length} shape${(a.shapes ?? []).length === 1 ? '' : 's'} in model ${a.model_id}`;
    case 'set_voxels': return `${(a.voxels ?? []).length} voxels in model ${a.model_id}`;
    case 'add_model': return `"${a.name}" ${(a.size ?? []).join('×')}`;
    case 'set_settings': return Object.keys(a.values ?? {}).join(', ');
    case 'set_object_animation': return `object ${a.object_id}, ${(a.keyframes ?? []).length} keys`;
    case 'move_object': return `object ${a.object_id} → ${(a.position ?? []).join(', ')}`;
    case 'set_material': return `colour ${a.index}: ${a.type}`;
    case 'set_palette': return `${(a.colors ?? []).length} colours`;
    case 'set_frame': return `frame ${a.frame}`;
    case 'set_camera_keyframes': return `${(a.keyframes ?? []).length} keys${a.end_frame !== undefined ? `, end ${a.end_frame}` : ''}`;
    default: return '';
  }
};
const LABELS: Record<string, string> = {
  get_scene: 'Looked at the scene', get_model: 'Read a model', set_voxels: 'Set voxels', draw_shapes: 'Drew', add_model: 'New model',
  move_object: 'Moved', set_object_animation: 'Animated', set_palette: 'Palette', set_material: 'Material', list_settings: 'Read settings',
  set_settings: 'Settings', set_camera_keyframes: 'Camera keys', set_frame: 'Frame', render_preview: 'Rendered a preview', undo: 'Undid', save_vox: 'Saved .vox', render_on_farm: 'Sent to the farm',
};

/** Add a part to the reply in progress (or start an "external" one for other Claude apps). */
function addPart(p: Part): () => void {
  let msg: Message | undefined;
  messages.update((ms) => {
    msg = ms.at(-1);
    if (!msg || msg.role !== 'assistant' || (!get(busy) && !msg.external)) {
      msg = { role: 'assistant', parts: [], external: !get(busy) };
      ms = [...ms, msg];
    }
    msg.parts.push(p);
    return [...ms];
  });
  return () => messages.update((ms) => [...ms]);
}

async function handleCall(app: App, call: { id: string; name: string; args: Record<string, unknown> }) {
  const part: Part = { kind: 'tool', name: LABELS[call.name] ?? call.name, summary: short(call.name, call.args), status: 'running' };
  const refresh = addPart(part);
  let out: ToolOutput;
  try {
    out = await runTool(app, call.name, call.args ?? {});
    part.status = 'done';
    const img = out.content.find((c) => c.type === 'image');
    if (img && img.type === 'image') part.image = `data:${img.mimeType};base64,${img.data}`;
  } catch (e) {
    out = { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
    part.status = 'error';
    part.summary = (e as Error).message;
  }
  refresh();
  await api('/api/assistant/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: call.id, ...out }) }).catch(() => {});
}

/** Connect to the bridge and keep reconnecting (EventSource retries by itself). */
export function connect(app: App) {
  let es: EventSource | null = null;
  const open = () => {
    es?.close();
    bridge.set({ state: 'connecting' });
    es = new EventSource(new URL(`/api/assistant/tab?id=${tabId}`, get(farmUrl)));
    es.addEventListener('hello', (e) => {
      const { claude } = JSON.parse((e as MessageEvent).data);
      bridge.set(claude ? { state: 'ready', claude } : { state: 'no-claude' });
    });
    es.addEventListener('call', (e) => void handleCall(app, JSON.parse((e as MessageEvent).data)));
    es.onerror = () => bridge.update((b) => (b.state === 'connecting' || b.state === 'offline' ? { state: 'offline' } : { state: 'connecting' }));
  };
  farmUrl.subscribe(() => open());
  // The tab you're looking at gets the tool calls.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible')
      api('/api/assistant/focus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: tabId }) }).catch(() => {});
  });
  void TOOL_DEFS; // tool definitions live in toolDefs.ts; the bridge lists them over MCP
}

export function newChat() {
  session = null;
  messages.set([]);
}

export async function stop() {
  await api('/api/assistant/stop', { method: 'POST' }).catch(() => {});
}

/** Send a chat message: Claude Code runs on this PC and uses the tools on this tab. */
export async function send(app: App, text: string) {
  if (!text.trim() || get(busy)) return;
  busy.set(true);
  const reply: Message = { role: 'assistant', parts: [], undoFrom: app.history.size };
  messages.update((ms) => [...ms, { role: 'user', parts: [{ kind: 'text', text }] }, reply]);
  const refresh = () => messages.update((ms) => [...ms]);
  let current: { kind: 'text'; text: string } | null = null;
  let streamed = false;
  const say = (t: string) => {
    if (!current || reply.parts.at(-1) !== current) {
      current = { kind: 'text', text: '' };
      reply.parts.push(current);
    }
    current.text += t;
    refresh();
  };
  try {
    const res = await api('/api/assistant/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, session }) });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `The bridge answered ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.session_id) session = ev.session_id;
        if (ev.type === 'stream_event') {
          const e = ev.event;
          if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') { streamed = true; say(e.delta.text); }
          if (e?.type === 'content_block_stop') current = null;
        } else if (ev.type === 'assistant' && !streamed) {
          for (const c of ev.message?.content ?? []) if (c.type === 'text') { say(c.text); current = null; }
        } else if (ev.type === 'assistant') {
          streamed = false; // next message may not stream
        } else if (ev.type === 'result' && ev.is_error) {
          reply.error = ev.result || 'Claude stopped with an error.';
        } else if (ev.type === 'bridge_error') {
          reply.error = ev.message;
        }
        refresh();
      }
    }
  } catch (e) {
    reply.error = `Couldn't reach the assistant bridge: ${(e as Error).message}. Start it on this PC with npm run farm.`;
  } finally {
    reply.undoTo = app.history.size;
    busy.set(false);
    refresh();
  }
}

/** Undo everything Claude changed in one reply (if nothing was done after it). */
export function undoReply(app: App, m: Message) {
  if (m.undoFrom === undefined || m.undoTo === undefined) return;
  while (app.history.size > m.undoFrom && app.history.size <= m.undoTo) {
    if (!app.history.undo()) break;
  }
  m.undoTo = m.undoFrom;
  messages.update((ms) => [...ms]);
}
