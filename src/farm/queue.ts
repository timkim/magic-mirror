// Render farm job queue: which frames are waiting, who is rendering what, and when to give a
// frame to someone else. No networking here, so it is easy to test.

import type { SettingValue } from '../core/settings';

export type FrameState = { state: 'todo' } | { state: 'leased'; worker: string; since: number } | { state: 'done'; worker: string; ms: number };

export interface JobSpec {
  name: string;
  firstFrame: number;
  lastFrame: number;
  samples: number;
  /** Multiplier on the output resolution (1 = full size). */
  scale: number;
  /** Every setting value from the app that submitted the job. */
  settings: Record<string, SettingValue>;
  hasHdr: boolean;
}

export interface Job extends JobSpec {
  id: string;
  status: 'uploading' | 'active' | 'done' | 'cancelled';
  created: number;
  finished?: number;
  frames: Map<number, FrameState>;
  /** Set once the coordinator has stitched a video. */
  video?: string;
}

export interface WorkerInfo {
  id: string;
  name: string;
  lastSeen: number;
  framesDone: number;
  current?: { jobId: string; frame: number };
}

export interface Work {
  jobId: string;
  frame: number;
  samples: number;
  scale: number;
}

let counter = 0;
const newId = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export class FarmQueue {
  readonly jobs = new Map<string, Job>();
  readonly workers = new Map<string, WorkerInfo>();

  /** A frame not reported back within this time goes to another worker. */
  constructor(public leaseMs = 10 * 60 * 1000) {}

  addJob(spec: JobSpec, now = Date.now()): Job {
    if (!(spec.lastFrame >= spec.firstFrame)) throw new Error('lastFrame must be ≥ firstFrame');
    const job: Job = { ...spec, id: newId(), status: 'uploading', created: now, frames: new Map() };
    for (let f = spec.firstFrame; f <= spec.lastFrame; f++) job.frames.set(f, { state: 'todo' });
    this.jobs.set(job.id, job);
    return job;
  }

  start(id: string) {
    const job = this.jobs.get(id);
    if (job && job.status === 'uploading') job.status = 'active';
  }

  cancel(id: string) {
    const job = this.jobs.get(id);
    if (job && job.status !== 'done') job.status = 'cancelled';
  }

  seen(workerId: string, name: string, now = Date.now()): WorkerInfo {
    let w = this.workers.get(workerId);
    if (!w) {
      w = { id: workerId, name, lastSeen: now, framesDone: 0 };
      this.workers.set(workerId, w);
    }
    w.lastSeen = now;
    w.name = name || w.name;
    return w;
  }

  /** Give the worker the next frame: oldest active job first, waiting frames, then expired leases. */
  nextWork(workerId: string, name = '', now = Date.now()): Work | null {
    const w = this.seen(workerId, name, now);
    const active = [...this.jobs.values()].filter((j) => j.status === 'active').sort((a, b) => a.created - b.created);
    for (const job of active) {
      let pick: number | undefined;
      for (const [f, s] of job.frames) {
        if (s.state === 'todo') { pick = f; break; }
      }
      if (pick === undefined)
        for (const [f, s] of job.frames)
          if (s.state === 'leased' && now - s.since > this.leaseMs) { pick = f; break; }
      if (pick !== undefined) {
        job.frames.set(pick, { state: 'leased', worker: workerId, since: now });
        w.current = { jobId: job.id, frame: pick };
        return { jobId: job.id, frame: pick, samples: job.samples, scale: job.scale };
      }
    }
    w.current = undefined;
    return null;
  }

  /** Record a finished frame. Returns true when this completed the whole job. */
  complete(jobId: string, frame: number, workerId: string, now = Date.now()): boolean {
    const job = this.jobs.get(jobId);
    const s = job?.frames.get(frame);
    if (!job || !s || s.state === 'done') return false;
    const since = s.state === 'leased' ? s.since : now;
    job.frames.set(frame, { state: 'done', worker: workerId, ms: now - since });
    const w = this.workers.get(workerId);
    if (w) { w.framesDone++; w.current = undefined; w.lastSeen = now; }
    if (job.status === 'active' && [...job.frames.values()].every((x) => x.state === 'done')) {
      job.status = 'done';
      job.finished = now;
      return true;
    }
    return false;
  }

  /** A worker couldn't render a frame: put it back in the queue. */
  fail(jobId: string, frame: number, workerId: string) {
    const s = this.jobs.get(jobId)?.frames.get(frame);
    if (s?.state === 'leased' && s.worker === workerId) this.jobs.get(jobId)!.frames.set(frame, { state: 'todo' });
    const w = this.workers.get(workerId);
    if (w) w.current = undefined;
  }

  status(now = Date.now()) {
    return {
      jobs: [...this.jobs.values()].map((j) => {
        const states = [...j.frames.values()];
        const done = states.filter((s) => s.state === 'done') as Extract<FrameState, { state: 'done' }>[];
        return {
          id: j.id,
          name: j.name,
          status: j.status,
          frames: [j.firstFrame, j.lastFrame],
          total: states.length,
          done: done.length,
          rendering: states.filter((s) => s.state === 'leased').length,
          avgFrameMs: done.length ? Math.round(done.reduce((n, s) => n + s.ms, 0) / done.length) : null,
          video: j.video ?? null,
        };
      }),
      workers: [...this.workers.values()].map((w) => ({ ...w, online: now - w.lastSeen < 30_000 })),
    };
  }
}
