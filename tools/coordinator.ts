// Magic Mirror render farm coordinator. Run it on one PC; it hands out animation frames to
// workers (browser tabs or `npm run worker` processes) on your network, saves the finished
// PNGs, and stitches a video with ffmpeg when a job completes (if ffmpeg is installed).
// It also serves the built app, so other PCs can just open http://<this-pc>:8080.
//
//   npm run build && npm run farm -- [--port 8080] [--out farm-output] [--lease 600]
//
// There is no login: run it on a trusted home network only.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { FarmQueue, type JobSpec } from '../src/farm/queue';

interface Options { port: number; out: string; leaseSeconds: number; dist: string }

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.vox': 'application/octet-stream', '.hdr': 'application/octet-stream', '.json': 'application/json', '.mp4': 'video/mp4',
};

function readBody(req: IncomingMessage, limit = 512 * 1024 * 1024): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { fail(new Error('Request too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', fail);
  });
}

const safeName = (s: string) => s.replace(/\.vox$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'job';

function hasFfmpeg(): Promise<boolean> {
  return new Promise((ok) => {
    const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    p.on('error', () => ok(false));
    p.on('exit', (code) => ok(code === 0));
  });
}

export function startCoordinator(opts: Partial<Options> = {}) {
  const o: Options = { port: 8080, out: 'farm-output', leaseSeconds: 600, dist: 'dist', ...opts };
  const queue = new FarmQueue(o.leaseSeconds * 1000);
  const store = new Map<string, { scene?: Buffer; hdr?: Buffer; dir: string }>();
  mkdirSync(o.out, { recursive: true });

  const send = (res: ServerResponse, code: number, body?: unknown, type = 'application/json') => {
    res.writeHead(code, {
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    if (body === undefined) res.end();
    else res.end(Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body));
  };

  const stitch = async (jobId: string) => {
    const job = queue.jobs.get(jobId)!;
    const dir = store.get(jobId)!.dir;
    if (!(await hasFfmpeg())) { console.log(`[farm] ${job.name}: done (install ffmpeg to get an .mp4 automatically)`); return; }
    const fps = Number(job.settings['anim.fps'] ?? 12) || 12;
    const name = safeName(job.name);
    const args = ['-y', '-loglevel', 'error', '-framerate', String(fps), '-start_number', String(job.firstFrame), '-i', join(dir, `${name}_%04d.png`),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'veryfast', join(dir, `${name}.mp4`)];
    await new Promise<void>((ok) => {
      const p = spawn('ffmpeg', args, { stdio: 'inherit' });
      p.on('exit', (code) => {
        if (code === 0) { job.video = `${name}.mp4`; console.log(`[farm] ${job.name}: video saved to ${join(dir, `${name}.mp4`)}`); }
        else console.log(`[farm] ${job.name}: ffmpeg failed (code ${code})`);
        ok();
      });
      p.on('error', () => ok());
    });
  };

  const serveStatic = (res: ServerResponse, path: string) => {
    const root = resolve(o.dist);
    const file = resolve(root, normalize('.' + (path === '/' ? '/index.html' : decodeURIComponent(path))));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      if (!existsSync(join(root, 'index.html'))) return send(res, 200, 'Magic Mirror farm is running. Run "npm run build" to also serve the app here.', 'text/plain');
      return send(res, 404, { error: 'Not found' });
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'OPTIONS') return send(res, 204);
      if (parts[0] !== 'api') return serveStatic(res, url.pathname);

      // GET /api/status
      if (req.method === 'GET' && parts[1] === 'status') return send(res, 200, queue.status());

      // POST /api/jobs  {name, firstFrame, lastFrame, samples, scale, settings, hasHdr}
      if (req.method === 'POST' && parts[1] === 'jobs' && parts.length === 2) {
        const spec = JSON.parse((await readBody(req, 16 * 1024 * 1024)).toString()) as JobSpec;
        const job = queue.addJob({
          name: String(spec.name ?? 'job'), firstFrame: Number(spec.firstFrame) | 0, lastFrame: Number(spec.lastFrame) | 0,
          samples: Math.max(1, Number(spec.samples) | 0), scale: Number(spec.scale) || 1, settings: spec.settings ?? {}, hasHdr: !!spec.hasHdr,
        });
        const dir = join(o.out, `${safeName(job.name)}-${job.id}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'job.json'), JSON.stringify({ ...spec, id: job.id }, null, 2));
        store.set(job.id, { dir });
        console.log(`[farm] new job ${job.name} (${job.id}): frames ${job.firstFrame}-${job.lastFrame}, ${job.samples} samples`);
        return send(res, 201, { id: job.id });
      }

      const job = parts[1] === 'jobs' && parts[2] ? queue.jobs.get(parts[2]) : undefined;
      const files = job ? store.get(job.id) : undefined;

      if (parts[1] === 'jobs' && parts[2] && (!job || !files)) return send(res, 404, { error: 'No such job' });

      if (job && files) {
        const what = parts[3];
        // GET /api/jobs/:id
        if (req.method === 'GET' && !what) return send(res, 200, { ...job, frames: undefined });
        // PUT/GET /api/jobs/:id/scene  and  /hdr
        if ((what === 'scene' || what === 'hdr') && req.method === 'PUT') {
          const body = await readBody(req);
          files[what] = body;
          writeFileSync(join(files.dir, what === 'scene' ? 'scene.vox' : 'sky.hdr'), body);
          return send(res, 204);
        }
        if ((what === 'scene' || what === 'hdr') && req.method === 'GET') {
          const body = files[what];
          return body ? send(res, 200, body, 'application/octet-stream') : send(res, 404, { error: `No ${what}` });
        }
        // POST /api/jobs/:id/start
        if (what === 'start' && req.method === 'POST') {
          if (!files.scene) return send(res, 400, { error: 'Upload the scene first' });
          if (job.hasHdr && !files.hdr) return send(res, 400, { error: 'Upload the HDR first' });
          queue.start(job.id);
          return send(res, 204);
        }
        if (what === 'cancel' && req.method === 'POST') { queue.cancel(job.id); return send(res, 204); }
        // PUT /api/jobs/:id/frames/:n?worker=ID   (PNG body)
        if (what === 'frames' && parts[4] !== undefined) {
          const frame = Number(parts[4]);
          const worker = url.searchParams.get('worker') ?? 'unknown';
          if (req.method === 'PUT') {
            const png = await readBody(req, 256 * 1024 * 1024);
            writeFileSync(join(files.dir, `${safeName(job.name)}_${String(frame).padStart(4, '0')}.png`), png);
            const finished = queue.complete(job.id, frame, worker);
            const st = queue.status().jobs.find((j) => j.id === job.id)!;
            console.log(`[farm] ${job.name} frame ${frame} from ${queue.workers.get(worker)?.name ?? worker} (${st.done}/${st.total})`);
            if (finished) void stitch(job.id);
            return send(res, 204);
          }
          if (req.method === 'POST' && parts[5] === 'fail') { queue.fail(job.id, frame, worker); return send(res, 204); }
        }
        // GET /api/jobs/:id/output/<file>  (finished frames and video)
        if (what === 'output' && parts[4] && req.method === 'GET') {
          const f = join(files.dir, parts[4].replace(/[\\/]/g, ''));
          if (!existsSync(f)) return send(res, 404, { error: 'Not found' });
          return send(res, 200, readFileSync(f), MIME[extname(f)] ?? 'application/octet-stream');
        }
      }

      // POST /api/work {worker, name}  → next frame or 204 when there's nothing to do
      if (req.method === 'POST' && parts[1] === 'work') {
        const { worker, name } = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
        if (!worker) return send(res, 400, { error: 'worker id required' });
        const work = queue.nextWork(String(worker), String(name ?? ''));
        return work ? send(res, 200, work) : send(res, 204);
      }

      return send(res, 404, { error: 'Unknown endpoint' });
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });

  server.listen(o.port, () => {
    const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
    console.log(`[farm] coordinator on port ${o.port}; output in ${resolve(o.out)}`);
    for (const ip of ips) console.log(`[farm] other PCs: open http://${ip}:${o.port}  or run: npm run worker -- http://${ip}:${o.port}`);
  });
  return { server, queue };
}

if (process.argv[1] && /coordinator\.(ts|mjs)$/.test(process.argv[1])) {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  startCoordinator({ port: Number(get('--port') ?? 8080), out: get('--out') ?? 'farm-output', leaseSeconds: Number(get('--lease') ?? 600) });
}
