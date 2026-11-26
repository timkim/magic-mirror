// Render farm panel: send the open animation to the coordinator, watch progress, and let this
// browser tab join the farm as a worker (any PC with a WebGPU browser can help render).

import type { Feature } from '../core/feature';
import type { App } from '../app';
import type { Job, Work } from '../farm/queue';
import { animationLength } from '../vox/scene';

interface Status {
  jobs: { id: string; name: string; status: string; total: number; done: number; rendering: number; avgFrameMs: number | null; video: string | null }[];
  workers: { id: string; name: string; online: boolean; framesDone: number; current?: { jobId: string; frame: number } }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

export const farmFeature: Feature = {
  id: 'farm',
  init(app) {
    const panel = app.layout.addPanel('left', 'Render farm', { collapsed: true, order: 5 });
    const b = panel.body;
    const saved = (() => { try { return localStorage.getItem('mm.farm.url'); } catch { return null; } })();
    b.innerHTML = `
      <label class="mm-row" title="Address of the PC running 'npm run farm'"><span class="mm-label">Coordinator</span><input class="mm-url" type="text"></label>
      <label class="mm-row"><span class="mm-label">Frames</span><span class="mm-vec3"><input class="mm-first" type="number" min="0" value="0"><input class="mm-last" type="number" min="0" value="0"></span></label>
      <label class="mm-row" title="Samples per frame"><span class="mm-label">Samples</span><input class="mm-spp" type="number" min="1" value="256"></label>
      <label class="mm-row" title="1 = full output resolution"><span class="mm-label">Scale</span><input class="mm-scale" type="number" min="0.1" max="1" step="0.05" value="1"></label>
      <button class="mm-send">Send to farm</button>
      <label class="mm-row" title="Render frames for the farm in this tab"><span class="mm-label">Join as worker</span><input class="mm-join" type="checkbox"></label>
      <div class="mm-farm-status mm-muted">Not connected.</div>`;
    const $ = <T extends HTMLElement>(sel: string) => b.querySelector(sel) as T;
    const url = $<HTMLInputElement>('.mm-url');
    url.value = saved ?? location.origin;
    url.addEventListener('change', () => { try { localStorage.setItem('mm.farm.url', url.value); } catch { /* storage unavailable */ } });
    const first = $<HTMLInputElement>('.mm-first'), last = $<HTMLInputElement>('.mm-last');
    const spp = $<HTMLInputElement>('.mm-spp'), scale = $<HTMLInputElement>('.mm-scale');
    const statusEl = $<HTMLDivElement>('.mm-farm-status');
    const join = $<HTMLInputElement>('.mm-join');
    spp.value = String(app.settings.num('anim.exportSamples'));

    const api = (path: string, init?: RequestInit) => fetch(new URL(path, url.value), init);

    app.on('sceneLoaded', (file) => {
      first.value = '0';
      last.value = String(animationLength(file));
    });

    $<HTMLButtonElement>('.mm-send').addEventListener('click', async () => {
      if (!app.fileBytes) return void (statusEl.textContent = 'Open a .vox first.');
      try {
        statusEl.textContent = 'Uploading…';
        const r = await api('/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: app.fileName,
            firstFrame: Number(first.value),
            lastFrame: Number(last.value),
            samples: Number(spp.value),
            scale: Number(scale.value),
            settings: app.settings.snapshot(),
            hasHdr: !!app.environment && app.settings.str('sky.mode') === 'hdr',
          }),
        });
        if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
        const { id } = await r.json();
        await api(`/api/jobs/${id}/scene`, { method: 'PUT', body: app.fileBytes as Uint8Array<ArrayBuffer> });
        if (app.environment && app.settings.str('sky.mode') === 'hdr')
          await api(`/api/jobs/${id}/hdr`, { method: 'PUT', body: app.environment.bytes as Uint8Array<ArrayBuffer> });
        const s = await api(`/api/jobs/${id}/start`, { method: 'POST' });
        if (!s.ok) throw new Error((await s.json()).error ?? s.statusText);
        statusEl.textContent = 'Job sent.';
        poll();
      } catch (e) {
        statusEl.textContent = `Couldn't reach the farm: ${(e as Error).message}`;
      }
    });

    // Progress list
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        while (!panel.root.classList.contains('collapsed') || join.checked) {
          try {
            const st = (await (await api('/api/status')).json()) as Status;
            const online = st.workers.filter((w) => w.online);
            const lines = st.jobs.slice(-5).reverse().map((j) => {
              const eta = j.avgFrameMs && online.length ? Math.ceil(((j.total - j.done) * j.avgFrameMs) / online.length / 60000) : null;
              const video = j.video ? ` · <a href="${new URL(`/api/jobs/${j.id}/output/${j.video}`, url.value)}" target="_blank">video</a>` : '';
              return `<div><b>${j.name}</b> ${j.status === 'active' ? `${j.done}/${j.total}${eta ? ` · ~${eta} min` : ''}` : j.status}${video}</div>`;
            });
            statusEl.innerHTML = `${online.length} worker${online.length === 1 ? '' : 's'} online${lines.length ? '' : ' · no jobs'}${lines.join('')}`;
          } catch {
            statusEl.textContent = 'Farm not reachable.';
          }
          await sleep(2000);
        }
      } finally {
        polling = false;
      }
    };
    panel.root.querySelector('h2')!.addEventListener('click', () => setTimeout(poll, 0));

    // Worker mode
    join.addEventListener('change', () => {
      if (join.checked) { poll(); void workLoop(app); }
    });

    async function workLoop(app: App) {
      const id = crypto.randomUUID();
      const name = `browser-${navigator.platform || 'pc'}-${id.slice(0, 4)}`;
      let jobId = '';
      app.layout.setStatus('farm', 'Farm worker: waiting for work');
      while (join.checked) {
        let work: Work | null = null;
        try {
          const r = await api('/api/work', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worker: id, name }) });
          work = r.status === 200 ? ((await r.json()) as Work) : null;
        } catch {
          app.layout.setStatus('farm', 'Farm worker: coordinator not reachable');
          await sleep(5000);
          continue;
        }
        if (!work) { await sleep(2000); continue; }
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
          app.layout.setStatus('farm', `Farm worker: rendering frame ${work.frame}`);
          while (app.renderer.samples < work.samples && join.checked) await nextFrame();
          if (!join.checked) { await api(`/api/jobs/${work.jobId}/frames/${work.frame}/fail?worker=${id}`, { method: 'POST' }); break; }
          const png = await app.renderPng();
          const put = await api(`/api/jobs/${work.jobId}/frames/${work.frame}?worker=${id}`, { method: 'PUT', body: png });
          if (!put.ok) throw new Error(`upload failed (${put.status})`);
          app.layout.setStatus('farm', `Farm worker: sent frame ${work.frame}`);
        } catch (e) {
          app.layout.setStatus('farm', `Farm worker: ${(e as Error).message}`);
          await api(`/api/jobs/${work.jobId}/frames/${work.frame}/fail?worker=${id}`, { method: 'POST' }).catch(() => {});
          jobId = '';
          await sleep(2000);
        }
      }
      app.layout.setStatus('farm', '');
    }
  },
};
