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
