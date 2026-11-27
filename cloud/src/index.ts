// Magic Mirror connector on Cloudflare Workers.
//
//   /mcp        MCP endpoint for claude.ai (OAuth-protected). Tool calls go to the relay.
//   /authorize  Sign-in: the owner enters their key to let Claude in.
//   /tab        WebSocket from the Magic Mirror tab (it authenticates with the same key).
//   /farm       Render farm status for the phone, with notifications (see farm.ts).
//   /status     A short status page.
//   everything else: the Magic Mirror app (static files from ../dist, see wrangler.jsonc).
//
// Tools are defined once in ../src/assistant/toolDefs.ts and run in the browser tab.

import { OAuthProvider, AuthorizationError, CimdFetchError, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { handleMcpPost } from '../../src/assistant/mcp';
import { relay, sameSecret, type Env } from './env';
import { farm } from './farm';

export { Relay } from './relay';

const SCOPES = ['mcp', 'offline_access'];
const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (title: string, body: string, status = 200, headers = new Headers()) => {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0a0a; color: #ededed; }
  main { width: min(420px, 100% - 32px); padding: 28px; border: 1px solid #262626; border-radius: 14px; background: #141414; }
  h1 { font-size: 19px; margin: 0 0 12px; } p { color: #a3a3a3; line-height: 1.5; font-size: 14px; }
  strong { color: #ededed; } code { color: #ededed; word-break: break-all; }
  input { width: 100%; box-sizing: border-box; margin: 6px 0 14px; padding: 10px 12px; border-radius: 8px; border: 1px solid #333; background: #0a0a0a; color: #ededed; font-size: 15px; }
  button { padding: 10px 16px; border-radius: 8px; border: 0; font-size: 14px; font-weight: 600; cursor: pointer; }
  .go { background: #ededed; color: #0a0a0a; } .no { background: transparent; color: #a3a3a3; border: 1px solid #333; }
  .warn { color: #fbbf24; } .err { color: #f87171; }
</style>
<main>${body}</main></html>`,
    { status, headers },
  );
};

function consentPage(d: ConsentDescription, handle: string, error = '') {
  const who = d.clientDomain ? `<strong>${escape(d.clientName)}</strong> (${escape(d.clientDomain)})` : `<strong>${escape(d.clientName)}</strong> (name not verified)`;
  return `<h1>Let Claude use Magic Mirror?</h1>
<p>${who} wants to view and change the scene open in your Magic Mirror tab: edit voxels, move the camera, change settings, render previews and send jobs to your farm.</p>
<p>Access goes to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn">This sends access to an app on a computer. Continue only if you just started connecting from it.</p>' : ''}
${error ? `<p class="err">${escape(error)}</p>` : ''}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <label for="key"><p style="margin:0">Your Magic Mirror key</p></label>
  <input id="key" name="key" type="password" autocomplete="current-password" required autofocus>
  <button class="go" name="decision" value="approve">Allow</button>
  <button class="no" name="decision" value="deny" formnovalidate>Deny</button>
</form>`;
}

/** Sign-in and consent (GET shows the page, POST checks the key). */
async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const auth = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(auth);
      const consent = await oauth.beginConsent(auth);
      return page('Allow Claude', consentPage(details, consent.handle), 200, consent.headers);
    }
    if (request.method === 'POST') {
      const form = await request.formData();
      const handle = String(form.get('handle') ?? '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      if (!env.OWNER_KEY || !(await sameSecret(String(form.get('key') ?? ''), env.OWNER_KEY))) {
        await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
        return page('Wrong key', `<h1>That key didn't match</h1><p>Go back to Claude and connect again. The key is the one you set with <code>wrangler secret put OWNER_KEY</code>.</p>`, 403);
      }
      const approved = await oauth.approveConsent(request, handle, { scope: SCOPES });
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: 'owner',
        metadata: { label: 'Magic Mirror owner' },
        scope: approved.request.scope,
        props: { userId: 'owner' },
      });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response('Method not allowed', { status: 405 });
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
      const message = e instanceof AuthorizationError ? e.description ?? 'This sign-in link has expired.' : 'This app could not be verified.';
      return page('Sign-in problem', `<h1>Sign-in problem</h1><p>${escape(message ?? '')}</p><p>Go back to Claude and connect again.</p>`, 400);
    }
    throw e;
  }
}

/** Everything outside /mcp. */
const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const farmResponse = await farm(request, env);
    if (farmResponse) return farmResponse;
    if (url.pathname === '/authorize') return authorize(request, env);
    if (url.pathname === '/tab') return relay(env).fetch(request); // the tab sends the key as its first message
    if (url.pathname === '/status' || url.pathname === '/') {
      const { tabs } = await relay(env).status();
      return page(
        'Magic Mirror connector',
        `<h1>Magic Mirror connector</h1>
<p>${tabs ? `<strong>${tabs} Magic Mirror tab${tabs > 1 ? 's' : ''} connected.</strong>` : 'No Magic Mirror tab is connected right now.'}</p>
<p>In claude.ai, add a custom connector with this address:<br><code>${escape(url.origin)}/mcp</code></p>
<p><a href="/" style="color:#ededed">Open Magic Mirror →</a> · <a href="/farm" style="color:#ededed">Farm status →</a></p>`,
      );
    }
    return new Response('Not found', { status: 404 });
  },
};

/** /mcp: reached only with a valid token. */
const mcpHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    const r = await handleMcpPost(await request.text(), (name, args) => relay(env).call(name, args));
    if (r.body === null) return new Response(null, { status: r.status });
    return Response.json(r.body, { status: r.status });
  },
};

// The OAuth provider needs the public address (the token audience), which is only known at
// request time, so build one per origin.
const providers = new Map<string, OAuthProvider<Env>>();
function providerFor(origin: string) {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpHandler as never,
      defaultHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: SCOPES,
      requiredScopes: ['mcp'],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
