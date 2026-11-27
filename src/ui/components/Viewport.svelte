<script lang="ts">
  // The render view: fits the image to the available space, hosts the WebGPU canvas and any
  // 'stage' overlays from features, and handles orbit (drag), pan (right-drag or Shift) and zoom.
  import { onMount } from 'svelte';
  import type { App } from '../../app';
  import { orbitDirection } from '../../render/params';

  let { app }: { app: App } = $props();
  const outputSize = app.outputSize;
  const scene = app.scene;
  const overlays = app.ui('stage');

  let viewport: HTMLElement;
  let canvas: HTMLCanvasElement;
  let box = $state({ w: 800, h: 600 });
  let dragging = $state(false);

  // Largest stage with the render's aspect ratio that fits the viewport.
  let stage = $derived.by(() => {
    const [w, h] = $outputSize;
    const k = Math.min((box.w - 24) / w, (box.h - 24) / h);
    return { w: Math.max(1, Math.floor(w * k)), h: Math.max(1, Math.floor(h * k)) };
  });

  onMount(() => {
    app.attachCanvas(canvas);
    const ro = new ResizeObserver(() => {
      box = { w: viewport.clientWidth, h: viewport.clientHeight };
      app.setViewportSize(viewport.clientWidth, viewport.clientHeight);
    });
    ro.observe(viewport);
    return () => ro.disconnect();
  });

  const s = app.settings;
  let drag: { x: number; y: number; pan: boolean } | null = null;

  function pointerdown(e: PointerEvent) {
    drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function pointermove(e: PointerEvent) {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.pan) {
      const yaw = (s.num('cam.yaw') * Math.PI) / 180;
      const back = orbitDirection(s.num('cam.yaw'), s.num('cam.pitch'));
      const right = [-Math.sin(yaw), Math.cos(yaw), 0];
      const up = [-back[2] * Math.cos(yaw), -back[2] * Math.sin(yaw), Math.hypot(back[0], back[1])];
      const k = (s.num('cam.distance') * Math.tan((s.num('cam.fov') * Math.PI) / 360) * 2) / stage.h;
      const t = s.vec('cam.target');
      // The scene follows the cursor, so the target moves the opposite way.
      s.set('cam.target', [0, 1, 2].map((i) => t[i] + (-right[i] * dx + up[i] * dy) * k) as [number, number, number]);
    } else {
      let yaw = s.num('cam.yaw') - dx * 0.3;
      if (yaw > 180) yaw -= 360;
      if (yaw < -180) yaw += 360;
      s.set('cam.yaw', yaw);
      s.set('cam.pitch', Math.max(-89, Math.min(89, s.num('cam.pitch') + dy * 0.3)));
    }
  }

  function wheel(e: WheelEvent) {
    e.preventDefault();
    const k = Math.exp(e.deltaY * 0.001);
    s.set('cam.distance', Math.max(1, s.num('cam.distance') * k));
    s.set('cam.orthoSize', Math.max(1, s.num('cam.orthoSize') * k));
  }

  function drop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    for (const f of Array.from(e.dataTransfer?.files ?? [])) app.openFile(f);
  }
</script>

<svelte:window
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={drop}
/>

<main class="relative grid place-items-center overflow-hidden bg-background [grid-area:view] {dragging ? 'outline-2 -outline-offset-8 outline-ring outline-dashed' : ''}" bind:this={viewport}>
  <div
    class="relative cursor-grab touch-none bg-black shadow-2xl ring-1 ring-border active:cursor-grabbing"
    style:width="{stage.w}px"
    style:height="{stage.h}px"
    role="application"
    aria-label="Render view: drag to orbit, right-drag to pan, scroll to zoom"
    onpointerdown={pointerdown}
    onpointermove={pointermove}
    onpointerup={() => (drag = null)}
    oncontextmenu={(e) => e.preventDefault()}
    onwheel={wheel}
  >
    <canvas bind:this={canvas} class="absolute inset-0 block size-full"></canvas>
    {#each overlays as o, i (i)}
      <o.component {app} />
    {/each}
  </div>
  {#if !$scene}
    <div class="pointer-events-none absolute text-center text-sm text-muted-foreground">
      Drop a .vox file here, or pick a test scene
    </div>
  {/if}
</main>
