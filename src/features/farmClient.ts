// Magic Prism farm client for the browser: talks to the coordinator, tracks job progress and
// runs this tab as a worker. Lives outside the panel component so closing the panel doesn't
// stop a worker that's rendering.

import { get, writable } from 'svelte/store';
import type { App } from '../app';
import { download } from '../app';
import type { Job, Work } from '../farm/queue';

export interface FarmStatus {
  jobs: { id: string; name: string; status: string; total: number; done: number; rendering: number; avgFrameMs: number | null; video: string | null }[];
  workers: { id: string; name: string; online: boolean; framesDone: number; current?: { jobId: string; frame: number } }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const savedUrl = (() => {
  try {
    return localStorage.getItem('mm.farm.url');
  } catch {
    return null;
  }
})();

export const farmUrl = writable(savedUrl ?? location.origin);
farmUrl.subscribe((v) => {
  try {
    localStorage.setItem('mm.farm.url', v);
  } catch {
    /* storage unavailable */
  }
});
/** Latest status, null before the first poll, 'unreachable' when the coordinator didn't answer. */
export const farmStatus = writable<FarmStatus | null | 'unreachable'>(null);
export const farmMessage = writable('');
export const joined = writable(false);

const api = (path: string, init?: RequestInit) => fetch(new URL(path, get(farmUrl)), init);

let watchers = 0;
let polling = false;
async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while (watchers > 0 || get(joined)) {
      try {
        farmStatus.set((await (await api('/api/status')).json()) as FarmStatus);
      } catch {
        farmStatus.set('unreachable');
      }
      await sleep(2000);
    }
  } finally {
    polling = false;
  }
}

/** Keep the status fresh while something is showing it. Returns a stop function. */
export function watchStatus(): () => void {
  watchers++;
  void pollLoop();
  return () => {
    watchers--;
  };
}

export function videoUrl(jobId: string, file: string) {
  return new URL(`/api/jobs/${jobId}/output/${file}`, get(farmUrl)).toString();
}

export async function sendJob(app: App, opts: { firstFrame: number; lastFrame: number; samples: number; scale: number }) {
  if (!app.fileBytes) return farmMessage.set('Open a .vox first.');
  try {
    farmMessage.set('Uploading…');
    const hasHdr = !!app.environment && app.settings.str('sky.mode') === 'hdr';
    const r = await api('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: app.fileName, ...opts, settings: app.settings.snapshot(), hasHdr }),
    });
    if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
    const { id } = await r.json();
    await api(`/api/jobs/${id}/scene`, { method: 'PUT', body: app.fileBytes as Uint8Array<ArrayBuffer> });
    if (hasHdr) await api(`/api/jobs/${id}/hdr`, { method: 'PUT', body: app.environment!.bytes as Uint8Array<ArrayBuffer> });
    const s = await api(`/api/jobs/${id}/start`, { method: 'POST' });
    if (!s.ok) throw new Error((await s.json()).error ?? s.statusText);
    farmMessage.set('Job sent.');
  } catch (e) {
    farmMessage.set(`Couldn't reach the farm: ${(e as Error).message}`);
  }
}

export function saveSettings(app: App) {
  const blob = new Blob([JSON.stringify(app.settings.snapshot(), null, 2)], { type: 'application/json' });
  download(blob, `${app.fileName.replace(/\.vox$/i, '') || 'scene'}-settings.json`);
}

/** Turn worker mode on or off for this tab. */
export function setJoined(app: App, on: boolean) {
  if (on === get(joined)) return;
  joined.set(on);
  if (on) {
    void pollLoop();
    void workLoop(app);
  }
}

async function workLoop(app: App) {
  const id = crypto.randomUUID();
  const name = `browser-${navigator.platform || 'pc'}-${id.slice(0, 4)}`;
  let jobId = '';
  app.setStatus('farm', 'Farm worker: waiting for work');
  while (get(joined)) {
    let work: Work | null = null;
    try {
      const r = await api('/api/work', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worker: id, name }) });
      work = r.status === 200 ? ((await r.json()) as Work) : null;
    } catch {
      app.setStatus('farm', 'Farm worker: coordinator not reachable');
      await sleep(5000);
      continue;
    }
    if (!work) {
      await sleep(2000);
      continue;
    }
    try {
      if (work.jobId !== jobId) {
        const job = (await (await api(`/api/jobs/${work.jobId}`)).json()) as Job;
        const scene = new Uint8Array(await (await api(`/api/jobs/${work.jobId}/scene`)).arrayBuffer());
        app.openVox(scene, job.name);
        if (job.hasHdr) app.loadEnvironment(new Uint8Array(await (await api(`/api/jobs/${work.jobId}/hdr`)).arrayBuffer()), 'farm sky.hdr');
        app.settings.apply(job.settings);
        jobId = work.jobId;
      }
      app.settings.set('out.previewScale', work.scale);
      app.settings.set('rt.maxSamples', Math.max(work.samples, 1));
      app.settings.set('anim.frame', work.frame);
      app.restart();
      await nextFrame();
      await nextFrame();
      app.setStatus('farm', `Farm worker: rendering frame ${work.frame}`);
      while (app.renderer.samples < work.samples && get(joined)) await nextFrame();
      if (!get(joined)) {
        await api(`/api/jobs/${work.jobId}/frames/${work.frame}/fail?worker=${id}`, { method: 'POST' });
        break;
      }
      const png = await app.renderPng();
      const put = await api(`/api/jobs/${work.jobId}/frames/${work.frame}?worker=${id}`, { method: 'PUT', body: png });
      if (!put.ok) throw new Error(`upload failed (${put.status})`);
      app.setStatus('farm', `Farm worker: sent frame ${work.frame}`);
    } catch (e) {
      app.setStatus('farm', `Farm worker: ${(e as Error).message}`);
      await api(`/api/jobs/${work.jobId}/frames/${work.frame}/fail?worker=${id}`, { method: 'POST' }).catch(() => {});
      jobId = '';
      await sleep(2000);
    }
  }
  app.setStatus('farm', '');
}
