# Magic Mirror connector (Cloudflare)

Lets Claude on any device (claude.ai, the phone app) use the Magic Mirror tab open on your PC.

```
claude.ai ──MCP──▶ this Worker ──WebSocket──▶ your Magic Mirror tab ──▶ the scene
```

The Worker only passes messages; rendering and files stay on your PC. It fits Cloudflare's free
Workers plan for personal use (Workers, Durable Objects and KV all have free daily allowances;
over a limit, requests fail until the daily reset rather than costing money).

## Set up (once, about 5 minutes)

You need a free Cloudflare account. From this folder on your PC:

```sh
npm install
npx wrangler login                      # opens Cloudflare in the browser
npx wrangler deploy                     # prints your address, e.g. https://magic-mirror.<you>.workers.dev
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"   # makes a key
npx wrangler secret put OWNER_KEY       # paste that key
```

Keep the key somewhere safe (a password manager). It's what lets Claude in and pairs your tabs.

Then:

1. **Pair Magic Mirror:** in the Assistant panel, press the phone button, enter the Worker
   address and the key, and press Connect. The browser remembers it.
2. **Add the connector in claude.ai:** Settings → Connectors → Add custom connector, with the
   address `https://magic-mirror.<you>.workers.dev/mcp`. Claude opens a sign-in page: enter your
   key and press Allow.

Now any Claude chat can work on your scene, as long as Magic Mirror is open on your PC.
The Worker's home page shows whether a tab is connected.

## How it works

- `src/index.ts`: OAuth 2.1 sign-in (via `@cloudflare/workers-oauth-provider`, with dynamic
  client registration and client metadata documents), the `/mcp` endpoint and the sign-in page.
  Only someone with the key can approve access.
- `src/relay.ts`: a Durable Object that holds the tab's WebSocket (hibernating while idle) and
  forwards tool calls to the most recently active tab. Large results (preview images) arrive in
  parts.
- Tools are the same as the local bridge's: `../src/assistant/toolDefs.ts`, run in the tab by
  `../src/assistant/tools.ts`. MCP handling is shared: `../src/assistant/mcp.ts`.

## Develop

```sh
printf 'OWNER_KEY=test-key\n' > .dev.vars
npx wrangler dev --local-protocol https   # https://localhost:8787, a self-signed certificate
```

To change the key: `npx wrangler secret put OWNER_KEY` again, then pair your tabs again. A new
key blocks new sign-ins and new pairings straight away; connections already open, and claude.ai
sign-ins already granted, last until they reconnect or their tokens expire. To end everything at
once, remove the connector in claude.ai and delete the Worker (`npx wrangler delete`).
