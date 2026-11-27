<script lang="ts">
  // Outlines over the render: the model being edited and what the brush would change.
  import type { App } from '../../app';
  import { project } from '../../edit/pick';
  import type { Vec3 } from '../../render/renderer';

  let { app }: { app: App } = $props();
  const { preview, enabled } = app.editor;
  const size = app.outputSize;

  // Re-project when the camera moves.
  let tick = $state(0);
  $effect(() => app.settings.onChange((k) => k.startsWith('cam.') && tick++));

  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  let lines = $derived.by(() => {
    void tick;
    if (!$enabled || !app.grid) return [];
    const cam = app.editor.host.cameraFrame();
    if (!cam) return [];
    const [w, h] = $size;
    const out: { d: string; kind: string }[] = [];
    for (const b of $preview.boxes.slice(0, 2000)) {
      const lo = b.min, hi = b.max.map((v) => v + 1);
      const corners: Vec3[] = [];
      for (let k = 0; k < 8; k++) corners.push([k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]]);
      const pts = corners.map((c) => project(cam, c, w / h));
      let d = '';
      for (const [a, c] of EDGES) {
        const p = pts[a], q = pts[c];
        if (p && q) d += `M${(p[0] * 100).toFixed(2)} ${(p[1] * 100).toFixed(2)}L${(q[0] * 100).toFixed(2)} ${(q[1] * 100).toFixed(2)}`;
      }
      out.push({ d, kind: b.kind });
    }
    return out;
  });
</script>

{#if lines.length}
  <svg class="pointer-events-none absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    {#each lines as l, i (i)}
      <path d={l.d} fill="none" vector-effect="non-scaling-stroke" stroke={l.kind === 'model' ? 'rgba(255,255,255,0.55)' : '#facc15'} stroke-width={l.kind === 'model' ? 1 : 1.5} stroke-dasharray={l.kind === 'model' ? '4 3' : undefined} />
    {/each}
  </svg>
{/if}
