// The relay: one Durable Object that keeps the live WebSocket to the Magic Mirror tab and passes
// tool calls to it. Uses WebSocket hibernation, so an idle connection costs nothing.
//
// Tab → relay messages: {type:'auth', key}, {type:'focus'}, {type:'result', id, part, total, data}
// (a tool result as JSON text, split into parts to stay under the WebSocket message limit).
// Relay → tab: {type:'ready'}, {type:'call', id, name, args}, {type:'error', message}.

import { DurableObject } from 'cloudflare:workers';
import type { ToolResult } from '../../src/assistant/mcp';
import { NO_TAB_MESSAGE } from '../../src/assistant/mcp';
import { sameSecret, type Env } from './env';
import { makeVapidKeys, sendPush, type PushSubscriptionJson, type VapidKeys } from './push';

/** What the coordinator reports (FarmQueue.status() plus when it was sent). */
export interface FarmReport {
  status: { jobs: { id: string; name: string; status: string; total: number; done: number; rendering: number; avgFrameMs: number | null; video: string | null; frames: [number, number] }[]; workers: { id: string; name: string; online: boolean; framesDone: number; current?: { jobId: string; frame: number } }[] };
  events?: FarmEvent[];
}
export interface FarmEvent { type: 'done'; jobId: string; name: string; frames: number; seconds?: number; at?: number }

interface Attachment { authed: boolean; since: number }
interface Pending { parts: string[]; got: number; ok: (r: ToolResult) => void; timer: ReturnType<typeof setTimeout> }

export class Relay extends DurableObject<Env> {
  private pending = new Map<string, Pending>();

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ authed: false, since: Date.now() } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private tabs() {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, a: ws.deserializeAttachment() as Attachment }))
      .filter((t) => t.a?.authed)
      .sort((x, y) => y.a.since - x.a.since);
  }

  /** How many Magic Mirror tabs are connected. */
  async status() {
    return { tabs: this.tabs().length };
  }

  /** Run a tool in the most recently active tab. */
  async call(name: string, args: unknown): Promise<ToolResult> {
    const tab = this.tabs()[0];
    if (!tab) return { isError: true, content: [{ type: 'text', text: NO_TAB_MESSAGE }] };
    const id = crypto.randomUUID();
    return new Promise<ToolResult>((ok) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        ok({ isError: true, content: [{ type: 'text', text: `Magic Mirror didn't answer ${name} within 3 minutes.` }] });
      }, 170_000);
      this.pending.set(id, { parts: [], got: 0, ok, timer });
      tab.ws.send(JSON.stringify({ type: 'call', id, name, args }));
    });
  }

  // ---- Farm status (reported by the coordinator, shown on /farm) ----------------------------

  async setFarm(report: FarmReport, origin: string) {
    const s = this.ctx.storage;
    await s.put('farm', { status: report.status, updatedAt: Date.now() });
    for (const e of report.events ?? []) {
      const event = { ...e, at: Date.now() };
      const events = ((await s.get<FarmEvent[]>('events')) ?? []).slice(-19);
      await s.put('events', [...events, event]);
      await this.notifyAll(origin);
    }
  }

  async getFarm() {
    const s = this.ctx.storage;
    const farm = (await s.get<{ status: FarmReport['status']; updatedAt: number }>('farm')) ?? null;
    const events = (await s.get<FarmEvent[]>('events')) ?? [];
    const thumbs = (await s.get<Record<string, number>>('thumbs')) ?? {};
    return { farm, events, thumbs, now: Date.now() };
  }

  async setThumb(jobId: string, jpeg: ArrayBuffer) {
    if (jpeg.byteLength > 1_500_000) return; // thumbnails only
    const s = this.ctx.storage;
    const thumbs = (await s.get<Record<string, number>>('thumbs')) ?? {};
    // Keep the newest 20 jobs' thumbnails.
    const keep = Object.entries({ ...thumbs, [jobId]: Date.now() }).sort((a, b) => b[1] - a[1]).slice(0, 20);
    for (const [id] of Object.entries(thumbs)) if (!keep.some(([k]) => k === id)) await s.delete(`thumb:${id}`);
    await s.put(`thumb:${jobId}`, jpeg);
    await s.put('thumbs', Object.fromEntries(keep));
  }

  async getThumb(jobId: string) {
    return (await this.ctx.storage.get<ArrayBuffer>(`thumb:${jobId}`)) ?? null;
  }

  async vapid(): Promise<VapidKeys> {
    let k = await this.ctx.storage.get<VapidKeys>('vapid');
    if (!k) {
      k = await makeVapidKeys();
      await this.ctx.storage.put('vapid', k);
    }
    return k;
  }

  async subscribe(sub: PushSubscriptionJson) {
    if (!/^https:\/\//.test(sub?.endpoint ?? '')) return 0;
    const subs = (await this.ctx.storage.get<PushSubscriptionJson[]>('subs')) ?? [];
    await this.ctx.storage.put('subs', [...subs.filter((x) => x.endpoint !== sub.endpoint), { endpoint: sub.endpoint }].slice(-10));
    return subs.length + 1;
  }

  /** Push to every subscribed phone; drop subscriptions the push service says are gone. */
  async notifyAll(origin: string) {
    const subs = (await this.ctx.storage.get<PushSubscriptionJson[]>('subs')) ?? [];
    if (!subs.length) return [];
    const keys = await this.vapid();
    const results = await Promise.all(subs.map((sub) => sendPush(sub, keys, origin).catch(() => 0)));
    const alive = subs.filter((_, i) => results[i] !== 404 && results[i] !== 410);
    if (alive.length !== subs.length) await this.ctx.storage.put('subs', alive);
    return results;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    const a = ws.deserializeAttachment() as Attachment;
    if (m.type === 'auth') {
      if (!this.env.OWNER_KEY || !(await sameSecret(String(m.key ?? ''), this.env.OWNER_KEY))) {
        ws.send(JSON.stringify({ type: 'error', message: 'Wrong key.' }));
        ws.close(4001, 'Wrong key');
        return;
      }
      ws.serializeAttachment({ authed: true, since: Date.now() } satisfies Attachment);
      ws.send(JSON.stringify({ type: 'ready' }));
      return;
    }
    if (!a?.authed) return;
    if (m.type === 'focus') ws.serializeAttachment({ ...a, since: Date.now() });
    if (m.type === 'result') {
      const p = this.pending.get(String(m.id));
      if (!p) return;
      const total = Number(m.total) || 1;
      p.parts[Number(m.part) || 0] = String(m.data ?? '');
      if (++p.got < total) return;
      clearTimeout(p.timer);
      this.pending.delete(String(m.id));
      try {
        p.ok(JSON.parse(p.parts.join('')) as ToolResult);
      } catch {
        p.ok({ isError: true, content: [{ type: 'text', text: 'Magic Mirror sent a result that could not be read.' }] });
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code, 'closing'); } catch { /* already closed */ }
  }
}
