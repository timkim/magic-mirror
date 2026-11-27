// Magic Prism render farm worker in Node (no browser). The native Rust worker, `prism`, is faster. Asks the coordinator for frames, renders each
// one with this PC's GPU, and sends the PNGs back. Run one per PC:
//
//   npm run worker -- http://192.168.1.20:8080 [--name living-room-pc] [--once]
//
// Each frame renders in its own short-lived process (the headless renderer), so a GPU or
// driver crash only fails that frame, and the coordinator hands it out again.
// --once exits when there's no work left (handy for scripts and tests).

import { hostname, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import type { Job, Work } from '../src/farm/queue';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Reply { status: number; body: Buffer; json<T>(): T }
function request(url: URL, method = 'GET', body?: Uint8Array | string, contentType?: string): Promise<Reply> {
  return new Promise((ok, fail) => {
    const mod = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string | number> = {};
    if (body !== undefined) { headers['Content-Length'] = Buffer.byteLength(body); if (contentType) headers['Content-Type'] = contentType; }
    const req = mod.request(url, { method, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        ok({ status: res.statusCode ?? 0, body: buf, json: <T>() => JSON.parse(buf.toString()) as T });
      });
    });
    req.on('error', fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The bundled headless renderer next to this file (npm run worker builds both). */
function rendererCommand(): string[] {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const built = join(here, 'render.mjs');
  if (existsSync(built)) return [process.execPath, built];
  throw new Error('Headless renderer not built; start the worker with "npm run worker"');
}

function run(cmd: string[], log: (s: string) => void): Promise<number> {
  return new Promise((ok) => {
    const p = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    p.stdout.on('data', () => {});
    p.on('exit', (code, signal) => {
      if (code !== 0) log(`  renderer exited with ${code ?? signal}: ${err.split('\n').filter((l) => l && !l.startsWith('Warning')).slice(-3).join(' | ')}`);
      ok(code ?? 1);
    });
  });
}

export async function runWorker(base: string, opts: { name?: string; once?: boolean; log?: (s: string) => void } = {}) {
  const log = opts.log ?? ((s: string) => console.log(s));
  const id = randomUUID();
  const name = opts.name ?? hostname();
  const cache = join(tmpdir(), `magic-prism-worker-${id}`);
  mkdirSync(cache, { recursive: true });
  const api = (path: string, method = 'GET', body?: Uint8Array | string, type?: string) => request(new URL(path, base), method, body, type);
  const download = async (path: string, to: string) => {
    const r = await api(path);
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    writeFileSync(to, r.body);
  };
  const renderer = rendererCommand();
  log(`[worker ${name}] connected to ${base}`);

  let loadedJob = '';
  for (;;) {
    let work: Work | null = null;
    try {
      const r = await api('/api/work', 'POST', JSON.stringify({ worker: id, name }), 'application/json');
      work = r.status === 200 ? r.json<Work>() : null;
    } catch (e) {
      log(`[worker ${name}] can't reach coordinator (${(e as Error).message}); retrying`);
      await sleep(5000);
      continue;
    }
    if (!work) {
      if (opts.once) break;
      await sleep(2000);
      continue;
    }
    const dir = join(cache, work.jobId);
    try {
      if (loadedJob !== work.jobId) {
        mkdirSync(dir, { recursive: true });
        const job = (await api(`/api/jobs/${work.jobId}`)).json<Job>();
        await download(`/api/jobs/${work.jobId}/scene`, join(dir, 'scene.vox'));
        if (job.hasHdr) await download(`/api/jobs/${work.jobId}/hdr`, join(dir, 'sky.hdr'));
        writeFileSync(join(dir, 'settings.json'), JSON.stringify(job.settings));
        writeFileSync(join(dir, 'job.json'), JSON.stringify({ ...job, frames: undefined }));
        loadedJob = work.jobId;
        log(`[worker ${name}] job ${job.name}: frames ${job.firstFrame}-${job.lastFrame}`);
      }
      const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')) as Job;
      const out = join(dir, `frame_${work.frame}.png`);
      const t0 = performance.now();
      const args = [...renderer, join(dir, 'scene.vox'), out, '--frame', String(work.frame), '--samples', String(work.samples),
        '--settings', join(dir, 'settings.json'), '--set', `out.previewScale=${work.scale}`];
      if (job.hasHdr) args.push('--hdr', join(dir, 'sky.hdr'));
      const code = await run(args, log);
      if (code !== 0 || !existsSync(out)) throw new Error('render failed');
      const put = await api(`/api/jobs/${work.jobId}/frames/${work.frame}?worker=${id}`, 'PUT', readFileSync(out), 'image/png');
      if (put.status >= 300) throw new Error(`upload failed: HTTP ${put.status}`);
      rmSync(out, { force: true });
      log(`[worker ${name}] frame ${work.frame} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      log(`[worker ${name}] frame ${work.frame} failed: ${(e as Error).message}`);
      await api(`/api/jobs/${work.jobId}/frames/${work.frame}/fail?worker=${id}`, 'POST').catch(() => {});
      loadedJob = '';
      await sleep(2000);
    }
  }
  rmSync(cache, { recursive: true, force: true });
}

if (process.argv[1] && /worker\.(ts|mjs)$/.test(process.argv[1])) {
  const a = process.argv.slice(2);
  const base = a.find((x) => /^https?:\/\//.test(x));
  if (!base) {
    console.error('usage: npm run worker -- http://<coordinator>:8080 [--name NAME] [--once]');
    process.exit(1);
  }
  const ni = a.indexOf('--name');
  runWorker(base, { name: ni >= 0 ? a[ni + 1] : undefined, once: a.includes('--once') }).catch((e) => { console.error(e); process.exit(1); });
}
