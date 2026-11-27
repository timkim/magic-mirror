// The assistant bridge, part of the coordinator (`npm run farm`). Three jobs:
//
// 1. MCP server at /mcp (Streamable HTTP, JSON responses). Any Claude client on this PC can use
//    Magic Mirror's tools: `claude mcp add --transport http magic-mirror http://localhost:8080/mcp`.
// 2. A live channel to the open Magic Mirror tab (server-sent events + POSTs). Tool calls are
//    relayed to the tab, which runs them on the scene and posts the result back.
// 3. The chat panel: each message runs Claude Code (`claude -p`) on this PC with the MCP server
//    above, so it uses the person's own Claude login. No API key.
//
// Only requests from this PC are accepted unless the coordinator runs with --assistant-lan.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_GUIDE } from '../src/assistant/toolDefs';
import { handleMcpPost, NO_TAB_MESSAGE } from '../src/assistant/mcp';

export interface AssistantOptions {
  port: number;
  /** Command for Claude Code (default "claude"). */
  claude: string;
  /** Accept requests from other machines too. */
  lan: boolean;
}

interface Tab { id: string; res: ServerResponse; since: number }
interface Pending { ok: (v: unknown) => void; timer: NodeJS.Timeout }

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const WIN = process.platform === 'win32';

/** Start a program; on Windows through the shell (npm installs claude as a .cmd) with quoted args. */
function run(cmd: string, args: string[]) {
  if (!WIN) return spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const q = (a: string) => `"${a.replace(/"/g, '\\"')}"`;
  return spawn([q(cmd), ...args.map(q)].join(' '), { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
}

export function createAssistant(o: AssistantOptions) {
  const tabs = new Map<string, Tab>();
  const pending = new Map<string, Pending>();
  let chat: ChildProcess | null = null;
  let claudeVersion: string | null = null;
  // Config files for the chat's Claude Code runs (no JSON or long text on the command line).
  const dir = mkdtempSync(join(tmpdir(), 'magic-mirror-'));
  const files = { mcp: join(dir, 'mcp.json'), prompt: join(dir, 'prompt.md') };
  writeFileSync(files.mcp, JSON.stringify({ mcpServers: { 'magic-mirror': { type: 'http', url: `http://127.0.0.1:${o.port}/mcp` } } }));
  writeFileSync(files.prompt, ASSISTANT_GUIDE + "\n\nYou are chatting in Magic Mirror's assistant panel, next to the scene. You only have the Magic Mirror tools.");

  // Is Claude Code installed?
  const probe = run(o.claude, ['--version']);
  probe.stdin?.end();
  probe.stdout?.on('data', (d) => (claudeVersion = String(d).trim()));
  probe.on('error', () => (claudeVersion = null));

  const json = (res: ServerResponse, code: number, body?: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...extra });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const body = (req: IncomingMessage) =>
    new Promise<string>((ok, fail) => {
      let s = '';
      req.on('data', (c) => { s += c; if (s.length > 64 * 1024 * 1024) req.destroy(); });
      req.on('end', () => ok(s));
      req.on('error', fail);
    });

  /** The tab that most recently connected (the one the person is looking at, usually). */
  const activeTab = () => [...tabs.values()].sort((a, b) => b.since - a.since)[0];

  function callTab(name: string, args: unknown): Promise<{ content: unknown[]; isError?: boolean }> {
    const tab = activeTab();
    if (!tab)
      return Promise.resolve({ isError: true, content: [{ type: 'text', text: NO_TAB_MESSAGE }] });
    const id = randomUUID();
    return new Promise((ok) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        ok({ isError: true, content: [{ type: 'text', text: `Magic Mirror didn't answer ${name} within 3 minutes.` }] });
      }, 180_000);
      pending.set(id, { ok: ok as (v: unknown) => void, timer });
      tab.res.write(`event: call\ndata: ${JSON.stringify({ id, name, args })}\n\n`);
    });
  }

  // ---- Chat: run Claude Code with our MCP server ------------------------------------------------
  function runChat(req: IncomingMessage, res: ServerResponse, message: string, session?: string) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    const emit = (e: unknown) => res.write(JSON.stringify(e) + '\n');
    if (!claudeVersion) {
      emit({ type: 'bridge_error', message: `Claude Code isn't installed on this PC (tried "${o.claude}"). Install it, run "claude" once to sign in, then restart npm run farm.` });
      return res.end();
    }
    chat?.kill();
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--mcp-config', files.mcp, '--strict-mcp-config',
      '--tools', '', '--allowedTools', 'mcp__magic-mirror',
      '--append-system-prompt-file', files.prompt,
      ...(session ? ['--resume', session] : []),
    ];
    const child = run(o.claude, args);
    chat = child;
    child.stdin!.end(message);
    let buf = '';
    let err = '';
    child.stdout!.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) res.write(line + '\n'); // Claude Code's stream-json events, passed through
      }
    });
    child.stderr!.on('data', (d) => (err += d));
    child.on('error', (e) => emit({ type: 'bridge_error', message: e.message }));
    child.on('exit', (code, signal) => {
      if (chat === child) chat = null;
      if (code && !signal) emit({ type: 'bridge_error', message: (err.trim().split('\n').pop() || `Claude Code exited with code ${code}`).slice(0, 500) });
      res.end();
    });
    req.on('close', () => { if (!res.writableEnded) child.kill(); });
  }

  /** Handles /mcp and /api/assistant/*. Returns false for anything else. */
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (path !== '/mcp' && !path.startsWith('/api/assistant/')) return false;
    if (!o.lan && !LOCAL.has(req.socket.remoteAddress ?? '')) {
      json(res, 403, { error: 'The assistant only accepts connections from this PC. Start the coordinator with --assistant-lan to allow your network.' });
      return true;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': '*' });
      res.end();
      return true;
    }

    if (path === '/mcp') {
      if (req.method !== 'POST') { json(res, 405, { error: 'POST JSON-RPC messages to /mcp' }, { Allow: 'POST' }); return true; }
      const r = await handleMcpPost(await body(req), callTab);
      if (r.body === null) { res.writeHead(r.status, { 'Access-Control-Allow-Origin': '*' }); res.end(); }
      else json(res, r.status, r.body);
      return true;
    }

    const what = path.slice('/api/assistant/'.length);
    if (what === 'status' && req.method === 'GET') {
      json(res, 200, { tabs: tabs.size, claude: claudeVersion, chatting: !!chat, mcp: `http://localhost:${o.port}/mcp` });
    } else if (what === 'tab' && req.method === 'GET') {
      // The browser tab's event stream: tool calls come down here.
      const id = url.searchParams.get('id') ?? randomUUID();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write(`event: hello\ndata: ${JSON.stringify({ claude: claudeVersion })}\n\n`);
      const tab = { id, res, since: Date.now() };
      tabs.set(id, tab);
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => { clearInterval(ping); if (tabs.get(id) === tab) tabs.delete(id); });
    } else if (what === 'focus' && req.method === 'POST') {
      // A tab became visible: make it the one tool calls go to.
      const t = tabs.get(JSON.parse(await body(req)).id);
      if (t) t.since = Date.now();
      json(res, 204);
    } else if (what === 'result' && req.method === 'POST') {
      const r = JSON.parse(await body(req));
      const p = pending.get(r.id);
      if (p) { clearTimeout(p.timer); pending.delete(r.id); p.ok({ content: r.content, isError: r.isError || undefined }); }
      json(res, 204);
    } else if (what === 'chat' && req.method === 'POST') {
      const { message, session } = JSON.parse(await body(req));
      runChat(req, res, String(message ?? ''), session ? String(session) : undefined);
    } else if (what === 'stop' && req.method === 'POST') {
      chat?.kill();
      json(res, 204);
    } else {
      json(res, 404, { error: 'Unknown assistant endpoint' });
    }
    return true;
  };
}
