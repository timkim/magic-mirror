import { describe, expect, it } from 'vitest';
import { FarmQueue } from '../src/farm/queue';

const spec = { name: 'city', firstFrame: 0, lastFrame: 3, samples: 8, scale: 1, settings: {}, hasHdr: false };

describe('FarmQueue', () => {
  it('only hands out frames once a job has started', () => {
    const q = new FarmQueue();
    const job = q.addJob(spec, 0);
    expect(q.nextWork('a', 'pc-a', 1)).toBeNull();
    q.start(job.id);
    expect(q.nextWork('a', 'pc-a', 2)?.frame).toBe(0);
  });

  it('spreads frames across workers and finishes the job', () => {
    const q = new FarmQueue();
    const job = q.addJob(spec, 0);
    q.start(job.id);
    const got: number[] = [];
    for (const w of ['a', 'b', 'a', 'b']) got.push(q.nextWork(w, w, 10)!.frame);
    expect(got).toEqual([0, 1, 2, 3]);
    expect(q.nextWork('c', 'c', 11)).toBeNull();
    expect(q.complete(job.id, 0, 'a', 20)).toBe(false);
    expect(q.complete(job.id, 1, 'b', 20)).toBe(false);
    expect(q.complete(job.id, 2, 'a', 20)).toBe(false);
    expect(q.complete(job.id, 3, 'b', 20)).toBe(true);
    expect(q.jobs.get(job.id)!.status).toBe('done');
    expect(q.status(20).workers.find((w) => w.id === 'a')!.framesDone).toBe(2);
  });

  it('reassigns a frame whose lease expired, and requeues failures', () => {
    const q = new FarmQueue(1000);
    const job = q.addJob({ ...spec, lastFrame: 1 }, 0);
    q.start(job.id);
    expect(q.nextWork('a', 'a', 0)!.frame).toBe(0);
    expect(q.nextWork('b', 'b', 0)!.frame).toBe(1);
    expect(q.nextWork('c', 'c', 500)).toBeNull();
    expect(q.nextWork('c', 'c', 1500)!.frame).toBe(0); // a went quiet
    q.fail(job.id, 1, 'b');
    expect(q.nextWork('d', 'd', 1600)!.frame).toBe(1);
    // A late result from the original worker still counts.
    q.complete(job.id, 0, 'a', 1700);
    q.complete(job.id, 1, 'd', 1700);
    expect(q.jobs.get(job.id)!.status).toBe('done');
  });

  it('serves the oldest job first and skips cancelled ones', () => {
    const q = new FarmQueue();
    const j1 = q.addJob({ ...spec, name: 'first', lastFrame: 0 }, 0);
    const j2 = q.addJob({ ...spec, name: 'second', lastFrame: 0 }, 1);
    q.start(j2.id);
    q.start(j1.id);
    expect(q.nextWork('a', 'a', 2)!.jobId).toBe(j1.id);
    q.cancel(j2.id);
    expect(q.nextWork('b', 'b', 3)).toBeNull();
  });
});
