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
npm run build                           # in the repo root: the app the Worker serves
cd cloud
npm install
npx wrangler login                      # opens Cloudflare in the browser
npm run deploy                          # prints your address, e.g. https://magic-mirror.<you>.workers.dev
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"   # makes a key
npx wrangler secret put OWNER_KEY       # paste that key
```

The address serves Magic Mirror itself at `/`, the farm page at `/farm`, the connector at `/mcp`
and a status page at `/status`.

### Deploying on every push

After the first deploy, GitHub can deploy for you: every push to `main` that passes the checks
goes live within a few minutes. In the GitHub repo, open Settings → Secrets and variables →
Actions and add:

- `CLOUDFLARE_ACCOUNT_ID`: from the Cloudflare dashboard (Workers & Pages, right-hand side).
- `CLOUDFLARE_API_TOKEN`: create one under My Profile → API Tokens → Create Token, using the
  "Edit Cloudflare Workers" template.

Your `OWNER_KEY` secret stays on Cloudflare; deploys don't touch it. Work on another branch
and merge to `main` when it's ready. (Cloudflare's per-branch preview addresses aren't
available for Workers that use Durable Objects, which the relay does.)

Keep the key somewhere safe (a password manager). It's what lets Claude in and pairs your tabs.

Then:

1. **Pair Magic Mirror:** in the Assistant panel, press the phone button, enter the Worker
   address and the key, and press Connect. The browser remembers it.
2. **Add the connector in claude.ai:** Settings → Connectors → Add custom connector, with the
   address `https://magic-mirror.<you>.workers.dev/mcp`. (Open Magic Mirror from the Worker's own
   address and the phone button already has it filled in.) Claude opens a sign-in page: enter your
   key and press Allow.

Now any Claude chat can work on your scene, as long as Magic Mirror is open on your PC.
The Worker's `/status` page shows whether a tab is connected.

## Farm status on your phone

`<your Worker address>/farm` shows your render jobs: progress, time left, which PCs are working
and the latest frame. Sign in with your key once; the phone remembers it for 30 days.

1. Start the coordinator with reporting on (the key goes in an environment variable, so it
   isn't in your shell history or the process list):
   ```sh
   # PowerShell:  $env:MAGIC_MIRROR_CLOUD_KEY = "<your key>"
   export MAGIC_MIRROR_CLOUD_KEY=<your key>
   npm run farm -- --cloud https://magic-mirror.<you>.workers.dev
   ```
   It sends status every few seconds while something changes, and a small JPEG of the newest
   frame every 30 seconds (made with ffmpeg, if installed). Frames and videos stay on your PC.
2. Open `/farm` on your phone and press **Notify me** to get a notification when a render
   finishes. On an iPhone, first add the page to your Home Screen (Share → Add to Home Screen)
   and open it from there; iOS only allows notifications for Home Screen web apps.

You can also just ask Claude ("how's the render going?"): the assistant has a `farm_status` tool.

## How it works

- `src/index.ts`: OAuth 2.1 sign-in (via `@cloudflare/workers-oauth-provider`, with dynamic
  client registration and client metadata documents), the `/mcp` endpoint and the sign-in page.
  Only someone with the key can approve access.
- `src/relay.ts`: a Durable Object that holds the tab's WebSocket (hibernating while idle) and
  forwards tool calls to the most recently active tab. Large results (preview images) arrive in
  parts.
- `src/farm.ts`: the `/farm` page, its sign-in cookie, the coordinator's report endpoints and the
  service worker; `src/push.ts`: VAPID-signed Web Push with no payload (the service worker
  fetches the status and writes the notification), so no third-party push service is involved.
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
