// MCP over HTTP (JSON-RPC, JSON responses), shared by the PC bridge (tools/assistant.ts) and the
// Cloudflare connector (cloud/src/index.ts). Both relay tool calls to the open Magic Mirror tab.

import { ASSISTANT_GUIDE, TOOL_DEFS } from './toolDefs';

export interface ToolResult {
  content: unknown[];
  isError?: boolean;
}
type Msg = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> };

async function handleOne(msg: Msg, callTool: (name: string, args: unknown) => Promise<ToolResult>) {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'magic-mirror', title: 'Magic Mirror', version: '0.3.0' },
        instructions: ASSISTANT_GUIDE,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOL_DEFS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      if (!TOOL_DEFS.some((t) => t.name === name)) return error(-32602, `Unknown tool ${name}`);
      return reply(await callTool(name, msg.params?.arguments ?? {}));
    }
    default:
      if (msg.id === undefined || msg.id === null) return null; // a notification: no reply
      return error(-32601, `Method not found: ${msg.method}`);
  }
}

/** Answer one POSTed MCP body. `body: null` means 202 Accepted with nothing to send. */
export async function handleMcpPost(text: string, callTool: (name: string, args: unknown) => Promise<ToolResult>): Promise<{ status: number; body: unknown | null }> {
  let parsed: Msg | Msg[];
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const batch = Array.isArray(parsed) ? parsed : [parsed];
  const out = (await Promise.all(batch.map((m) => handleOne(m, callTool)))).filter(Boolean);
  if (out.length === 0) return { status: 202, body: null };
  return { status: 200, body: Array.isArray(parsed) ? out : out[0] };
}

export const NO_TAB_MESSAGE = 'Magic Mirror is not open. Ask the user to open it in a browser on their PC (it connects automatically).';
