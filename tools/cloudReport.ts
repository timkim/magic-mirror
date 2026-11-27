// Sends the farm's progress to the Magic Mirror Worker (cloud/), so /farm on the phone shows it
// and can notify when a render finishes. Status every few seconds while anything changes, and a
// small JPEG of the newest frame (made with ffmpeg, when installed) now and then.
//
//   npm run farm -- --cloud https://magic-mirror.<you>.workers.dev
//   with the key in the MAGIC_MIRROR_CLOUD_KEY environment variable (or --cloud-key).

import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FarmQueue } from '../src/farm/queue';

export interface CloudReporterOptions {
  url: string;
  key: string;
  /** Path of the newest finished frame of a job, if any. */
  latestFrame: (jobId: string) => string | null;
  intervalMs?: number;
  thumbEveryMs?: number;
}

function jpegThumb(png: string): Promise<Buffer | null> {
  const out = join(tmpdir(), `mm-thumb-${process.pid}-${Date.now()}.jpg`);
  return new Promise((ok) => {
    const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', png, '-vf', 'scale=480:-2', '-q:v', '6', out], { stdio: 'ignore' });
    p.on('error', () => ok(null));
    p.on('exit', async (code) => {
      if (code !== 0) return ok(null);
      const b = await readFile(out).catch(() => null);
      await rm(out, { force: true });
      ok(b);
    });
  });
}

export function startCloudReporter(queue: FarmQueue, o: CloudReporterOptions) {
  const base = o.url.replace(/\/+$/, '');
  const auth = { Authorization: `Bearer ${o.key}` };
  const doneJobs = new Set<string>();
  const started = new Map<string, number>();
  const thumbSent = new Map<string, { at: number; frame: string }>();
  let last = '';
  let lastSent = 0;
  let warned = false;
  for (const j of queue.jobs.values()) if (j.status === 'done') doneJobs.add(j.id); // only report new completions

  const post = async (path: string, body: BodyInit, type: string) => {
    const r = await fetch(base + path, { method: 'POST', headers: { ...auth, 'Content-Type': type }, body });
    if (r.status === 401) throw new Error('the Worker refused the key (check MAGIC_MIRROR_CLOUD_KEY)');
    if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  };

  const tick = async () => {
    try {
      const status = queue.status();
      const events = [];
      for (const j of status.jobs) {
        if (j.status === 'active' && !started.has(j.id)) started.set(j.id, Date.now());
        if (j.status === 'done' && !doneJobs.has(j.id)) {
          doneJobs.add(j.id);
          const t0 = started.get(j.id);
          events.push({ type: 'done', jobId: j.id, name: j.name, frames: j.total, seconds: t0 ? Math.round((Date.now() - t0) / 1000) : undefined });
        }
      }
      const json = JSON.stringify({ status, events });
      // Send when something changed, and at least once a minute so the page knows the PC is up.
      if (json !== last || events.length || Date.now() - lastSent > 60_000) {
        await post('/farm/report', json, 'application/json');
        last = json;
        lastSent = Date.now();
      }
      // Thumbnails: the newest frame of active jobs every so often, and once when a job ends.
      for (const j of status.jobs) {
        if (j.status !== 'active' && !(j.status === 'done' && events.some((e) => e.jobId === j.id))) continue;
        const frame = o.latestFrame(j.id);
        const prev = thumbSent.get(j.id);
        if (!frame || prev?.frame === frame) continue;
        if (prev && j.status === 'active' && Date.now() - prev.at < (o.thumbEveryMs ?? 30_000)) continue;
        const jpeg = await jpegThumb(frame);
        if (jpeg) await post(`/farm/thumb/${encodeURIComponent(j.id)}`, new Uint8Array(jpeg), 'image/jpeg');
        thumbSent.set(j.id, { at: Date.now(), frame });
      }
      if (warned) console.log('[prism] cloud: reporting again');
      warned = false;
    } catch (e) {
      if (!warned) console.log(`[prism] cloud: couldn't report to ${base}: ${(e as Error).message}`);
      warned = true;
    }
  };
  const timer = setInterval(tick, o.intervalMs ?? 5000);
  void tick();
  console.log(`[prism] cloud: reporting farm status to ${base}/farm`);
  return { stop: () => clearInterval(timer), tick };
}
