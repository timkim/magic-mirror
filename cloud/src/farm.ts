// Farm status on the phone: /farm shows jobs, progress, workers and the latest frame, and can
// send a notification when a render finishes. The coordinator on the PC reports here
// (`npm run farm -- --cloud <worker address>`, with the key in MAGIC_MIRROR_CLOUD_KEY).
//
//   POST /farm/report         coordinator → status + events   (Authorization: Bearer <key>)
//   POST /farm/thumb/:job     coordinator → latest frame JPEG  (same)
//   GET  /farm                the page (sign in with the key once; a cookie remembers it)
//   GET  /farm/status.json    for the page and its service worker
//   GET  /farm/thumb/:job     thumbnails
//   GET  /farm/vapid          push public key;  POST /farm/subscribe  a phone's push subscription
//   GET  /farm/sw.js, /farm/manifest.webmanifest, /farm/icon.svg   so it can be added to the home screen

import { relay, sameSecret, type Env } from './env';
import type { FarmReport } from './relay';

const COOKIE = 'mm_farm';
const DAYS = 30;

async function hmac(key: string, msg: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sessionCookie(env: Env) {
  const exp = Date.now() + DAYS * 86400_000;
  return `${COOKIE}=${exp}.${await hmac(env.OWNER_KEY, `farm|${exp}`)}; Path=/farm; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 86400}`;
}

async function signedIn(request: Request, env: Env) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([0-9a-f]+)`).exec(request.headers.get('Cookie') ?? '');
  if (!m || Number(m[1]) < Date.now() || !env.OWNER_KEY) return false;
  return sameSecret(m[2], await hmac(env.OWNER_KEY, `farm|${m[1]}`));
}

async function bearerOk(request: Request, env: Env) {
  const t = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  return !!t && !!env.OWNER_KEY && sameSecret(t, env.OWNER_KEY);
}

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0a0a0a"/><path d="M32 10 54 50H10Z" fill="none" stroke="#ededed" stroke-width="4" stroke-linejoin="round"/><path d="M32 30 46 50" stroke="#f59e0b" stroke-width="4"/><path d="M32 30 18 50" stroke="#38bdf8" stroke-width="4"/></svg>`;

const SW = `// Magic Prism farm: show a notification when a render finishes.
self.addEventListener('push', (e) => e.waitUntil((async () => {
  let title = 'Magic Prism', body = 'A render finished.';
  try {
    const s = await (await fetch('/farm/status.json', { credentials: 'include' })).json();
    const ev = s.events[s.events.length - 1];
    if (ev) { title = ev.name + ' finished'; body = ev.frames + ' frames' + (ev.seconds ? ' in ' + Math.round(ev.seconds / 60) + ' min' : '') + '. The video is on your PC.'; }
  } catch {}
  await self.registration.showNotification(title, { body, icon: '/farm/icon.svg', tag: 'magic-prism' });
})()));
self.addEventListener('notificationclick', (e) => { e.notification.close(); e.waitUntil(clients.openWindow('/farm')); });
`;

const MANIFEST = JSON.stringify({
  name: 'Magic Prism farm', short_name: 'Magic Prism', start_url: '/farm', scope: '/farm', display: 'standalone',
  background_color: '#0a0a0a', theme_color: '#0a0a0a', icons: [{ src: '/farm/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
});

const shell = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a0a0a"><link rel="manifest" href="/farm/manifest.webmanifest"><link rel="icon" href="/farm/icon.svg"><link rel="apple-touch-icon" href="/farm/icon.svg">
<meta name="apple-mobile-web-app-capable" content="yes"><title>Magic Prism farm</title>
<style>
  :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0a0a0a; color: #ededed; padding: max(16px, env(safe-area-inset-top)) 16px 32px; }
  main { max-width: 560px; margin: 0 auto; display: grid; gap: 14px; }
  h1 { font-size: 20px; margin: 4px 0 0; } h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #a3a3a3; margin: 10px 0 0; }
  .muted { color: #a3a3a3; font-size: 13px; } .warn { color: #fbbf24; font-size: 13px; }
  .card { border: 1px solid #262626; border-radius: 14px; background: #141414; padding: 14px; display: grid; gap: 10px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #262626; color: #d4d4d4; white-space: nowrap; }
  .badge.active { background: #422006; color: #fbbf24; } .badge.done { background: #052e16; color: #4ade80; }
  .bar { height: 8px; border-radius: 99px; background: #262626; overflow: hidden; } .bar > i { display: block; height: 100%; background: #ededed; }
  img.thumb { max-width: 100%; max-height: 42vh; justify-self: center; border-radius: 10px; border: 1px solid #262626; display: block; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; }
  input { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid #333; background: #0a0a0a; color: #ededed; font-size: 16px; }
  button { padding: 12px 16px; border-radius: 10px; border: 0; background: #ededed; color: #0a0a0a; font-weight: 600; font-size: 15px; }
  button.ghost { background: transparent; color: #ededed; border: 1px solid #333; }
</style><main>${body}</main></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers } },
  );

const LOGIN = (error = '') => `<h1>Magic Prism farm</h1>
<form method="post" action="/farm/login" class="card">
  <label class="muted" for="key">Your Magic Mirror key</label>
  <input id="key" name="key" type="password" autocomplete="current-password" required autofocus>
  ${error ? `<p class="warn" style="margin:0">${error}</p>` : ''}
  <button>Sign in</button>
</form>`;

const APP = `<div class="row"><h1>Magic Prism farm</h1><button class="ghost" id="notify" hidden>Notify me</button></div>
<p class="muted" id="updated">Loading…</p>
<div id="jobs"></div>
<h2>Workers</h2>
<div class="card" id="workers"></div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const dur = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'under a minute' : m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
async function refresh() {
  let s;
  try { const r = await fetch('/farm/status.json', { credentials: 'include' }); if (r.status === 401) return location.reload(); s = await r.json(); } catch { return; }
  const f = s.farm;
  if (!f) { $('updated').textContent = 'No report from your coordinator yet. Start it with --cloud (see cloud/README.md).'; return; }
  const age = (s.now - f.updatedAt) / 1000;
  $('updated').className = age > 60 ? 'warn' : 'muted';
  $('updated').textContent = age > 60 ? 'Last heard from your PC ' + dur(age * 1000) + ' ago. Is the coordinator running?' : 'Updated ' + Math.round(age) + ' s ago';
  const online = f.status.workers.filter((w) => w.online).length;
  const jobs = [...f.status.jobs].reverse();
  $('jobs').innerHTML = jobs.length ? jobs.map((j) => {
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    const left = j.total - j.done;
    const eta = j.status === 'active' && j.avgFrameMs && online ? ' · about ' + dur((left * j.avgFrameMs) / online) + ' left' : '';
    const thumb = s.thumbs[j.id] ? '<img class="thumb" alt="Latest frame" src="/farm/thumb/' + esc(j.id) + '?t=' + s.thumbs[j.id] + '">' : '';
    return '<div class="card"><div class="row"><span class="name">' + esc(j.name) + '</span><span class="badge ' + esc(j.status) + '">' + esc(j.status) + '</span></div>' +
      '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="muted">' + j.done + ' / ' + j.total + ' frames (' + pct + '%)' + (j.rendering ? ' · ' + j.rendering + ' rendering' : '') + eta + (j.video ? ' · video ready on your PC' : '') + '</div>' + thumb + '</div>';
  }).join('') : '<div class="card muted">No jobs yet.</div>';
  $('workers').innerHTML = f.status.workers.length ? f.status.workers.map((w) =>
    '<div class="row"><span><span class="dot" style="background:' + (w.online ? '#4ade80' : '#525252') + '"></span>' + esc(w.name || w.id.slice(0, 8)) + '</span><span class="muted">' +
    (w.current && w.online ? 'frame ' + w.current.frame + ' · ' : '') + w.framesDone + ' done</span></div>').join('') : '<span class="muted">No workers yet.</span>';
}
refresh(); setInterval(refresh, 5000);

// Notifications: a service worker shows one when a render finishes.
const b64 = (s) => { const p = s.replace(/-/g, '+').replace(/_/g, '/'); const r = atob(p + '='.repeat((4 - p.length % 4) % 4)); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
async function setupNotify() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const reg = await navigator.serviceWorker.register('/farm/sw.js', { scope: '/farm' });
  const btn = $('notify');
  const existing = await reg.pushManager.getSubscription();
  btn.hidden = false;
  btn.textContent = existing ? 'Notifications on' : 'Notify me';
  btn.onclick = async () => {
    if (await Notification.requestPermission() !== 'granted') { btn.textContent = 'Notifications blocked'; return; }
    const { publicKey } = await (await fetch('/farm/vapid', { credentials: 'include' })).json();
    const sub = existing ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) });
    const r = await fetch('/farm/subscribe', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
    btn.textContent = r.ok ? 'Notifications on' : 'Try again';
  };
}
setupNotify().catch(() => {});
</script>`;

/** Handles /farm and below. Returns null for other paths. */
export async function farm(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== '/farm' && !path.startsWith('/farm/')) return null;
  const r = relay(env);

  // Public bits the browser needs to install and run the page.
  if (path === '/farm/icon.svg') return new Response(ICON, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' } });
  if (path === '/farm/manifest.webmanifest') return new Response(MANIFEST, { headers: { 'Content-Type': 'application/manifest+json' } });
  if (path === '/farm/sw.js') return new Response(SW, { headers: { 'Content-Type': 'text/javascript', 'Service-Worker-Allowed': '/farm', 'Cache-Control': 'no-cache' } });

  // From the coordinator.
  if (request.method === 'POST' && (path === '/farm/report' || path.startsWith('/farm/thumb/'))) {
    if (!(await bearerOk(request, env))) return new Response('Wrong key', { status: 401 });
    if (path === '/farm/report') {
      await r.setFarm((await request.json()) as FarmReport, url.origin);
      return new Response(null, { status: 204 });
    }
    await r.setThumb(decodeURIComponent(path.slice('/farm/thumb/'.length)), await request.arrayBuffer());
    return new Response(null, { status: 204 });
  }

  if (path === '/farm/login' && request.method === 'POST') {
    const key = String((await request.formData()).get('key') ?? '');
    if (!env.OWNER_KEY || !(await sameSecret(key, env.OWNER_KEY))) {
      await new Promise((ok) => setTimeout(ok, 1000));
      return shell(LOGIN("That key didn't match."), 403);
    }
    return new Response(null, { status: 303, headers: { Location: '/farm', 'Set-Cookie': await sessionCookie(env) } });
  }

  const ok = await signedIn(request, env);
  if (path === '/farm') return shell(ok ? APP : LOGIN());
  if (!ok) return Response.json({ error: 'Sign in at /farm' }, { status: 401 });
  if (path === '/farm/status.json') return Response.json(await r.getFarm(), { headers: { 'Cache-Control': 'no-store' } });
  if (path.startsWith('/farm/thumb/') && request.method === 'GET') {
    const jpeg = await r.getThumb(decodeURIComponent(path.slice('/farm/thumb/'.length)));
    return jpeg ? new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' } }) : new Response('No thumbnail', { status: 404 });
  }
  if (path === '/farm/vapid') return Response.json({ publicKey: (await r.vapid()).publicKey });
  if (path === '/farm/subscribe' && request.method === 'POST') {
    const n = await r.subscribe((await request.json().catch(() => null)) as never);
    return n ? Response.json({ subscriptions: n }) : Response.json({ error: 'Bad subscription' }, { status: 400 });
  }
  return new Response('Not found', { status: 404 });
}
