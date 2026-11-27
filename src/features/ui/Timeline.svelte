<script lang="ts">
  // Animation timeline: scrub, step and play keyframes and flipbooks, and export every frame as
  // a PNG sequence (straight into a folder in Chrome/Edge). Hidden for static scenes.
  import { onMount } from 'svelte';
  import type { App } from '../../app';
  import { download } from '../../app';
  import { settingStore } from '../../ui/stores';
  import { animationLength } from '../../vox/scene';
  import { Button } from '$lib/components/ui/button';
  import { Slider } from '$lib/components/ui/slider';
  import { Input } from '$lib/components/ui/input';
  import { Switch } from '$lib/components/ui/switch';
  import SkipBackIcon from '@lucide/svelte/icons/skip-back';
  import SkipForwardIcon from '@lucide/svelte/icons/skip-forward';
  import StepBackIcon from '@lucide/svelte/icons/step-back';
  import StepForwardIcon from '@lucide/svelte/icons/step-forward';
  import PlayIcon from '@lucide/svelte/icons/play';
  import PauseIcon from '@lucide/svelte/icons/pause';
  import FilmIcon from '@lucide/svelte/icons/film';
  import XIcon from '@lucide/svelte/icons/x';

  let { app }: { app: App } = $props();
  const s = app.settings;
  const scene = app.scene;
  const frame = settingStore<number>(s, 'anim.frame');
  const fps = settingStore<number>(s, 'anim.fps');
  const playSamples = settingStore<number>(s, 'anim.playSamples');
  const exportSamples = settingStore<number>(s, 'anim.exportSamples');
  const loop = settingStore<boolean>(s, 'anim.loop');

  let length = $derived($scene ? animationLength($scene.file) : 0);
  let playing = $state(false);
  let exporting = $state(false);
  let cancelExport = false;
  let lastAdvance = 0;

  function setFrame(f: number) {
    if (length <= 0) return;
    if (f > length) f = $loop ? 0 : length;
    if (f < 0) f = $loop ? length : 0;
    if (f !== $frame) $frame = f;
  }

  function togglePlay() {
    if (exporting || length <= 0) return;
    playing = !playing;
    lastAdvance = 0;
  }

  onMount(() => {
    const offScene = app.on('sceneLoaded', (file) => {
      playing = false;
      if (s.num('anim.frame') > animationLength(file)) s.set('anim.frame', 0);
    });
    // Playback moves on once the frame has enough samples, at most `fps` times a second.
    const offFrame = app.on('frame', () => {
      if (!playing || exporting) return;
      const now = performance.now();
      const ready = app.renderer.samples >= Math.min(s.num('anim.playSamples'), s.num('rt.maxSamples'));
      if (ready && now - lastAdvance >= 1000 / s.num('anim.fps')) {
        lastAdvance = now;
        if (!s.bool('anim.loop') && s.num('anim.frame') >= length) {
          playing = false;
          return;
        }
        setFrame(s.num('anim.frame') + 1);
      }
    });
    return () => {
      offScene();
      offFrame();
    };
  });

  function keydown(e: KeyboardEvent) {
    if (length <= 0 || (e.target as HTMLElement).closest('input, select, textarea, [contenteditable]')) return;
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    }
    if (e.key === ',') setFrame($frame - 1);
    if (e.key === '.') setFrame($frame + 1);
  }

  const waitFor = (cond: () => boolean) =>
    new Promise<void>((resolve) => {
      const tick = () => (cond() ? resolve() : requestAnimationFrame(tick));
      tick();
    });

  async function exportFrames() {
    if (exporting) {
      cancelExport = true;
      return;
    }
    if (!app.renderer.ready) return;
    const target = s.num('anim.exportSamples');
    const picker = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    let dir: FileSystemDirectoryHandle | null = null;
    if (picker) {
      try {
        dir = await picker({ mode: 'readwrite' });
      } catch {
        return; // cancelled
      }
    }
    exporting = true;
    cancelExport = false;
    playing = false;
    const savedMax = s.num('rt.maxSamples');
    s.set('rt.maxSamples', Math.max(savedMax, target));
    const base = app.fileName.replace(/\.vox$/i, '') || 'render';
    try {
      for (let f = 0; f <= length && !cancelExport; f++) {
        s.set('anim.frame', f);
        await waitFor(() => cancelExport || app.renderer.samples >= target);
        if (cancelExport) break;
        const blob = await app.renderPng();
        const name = `${base}_${String(f).padStart(4, '0')}.png`;
        if (dir) {
          const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
          await w.write(blob);
          await w.close();
        } else download(blob, name);
        app.setStatus('msg', `Exported ${name} (${f + 1}/${length + 1})`);
      }
      app.setStatus('msg', cancelExport ? 'Export cancelled' : `Exported ${length + 1} frames${dir ? ` to ${dir.name}` : ''}`);
    } catch (e) {
      app.setStatus('msg', `Export failed: ${(e as Error).message}`);
    } finally {
      s.set('rt.maxSamples', savedMax);
      exporting = false;
    }
  }

  const numberField = 'h-7 w-16 px-1.5 text-xs tabular-nums';
</script>

<svelte:window onkeydown={keydown} />

{#if length > 0}
  <div class="flex items-center gap-1.5 border-t border-border px-3 py-2">
    <Button variant="ghost" size="icon-sm" title="First frame" aria-label="First frame" onclick={() => setFrame(0)}><SkipBackIcon /></Button>
    <Button variant="ghost" size="icon-sm" title="Previous frame (,)" aria-label="Previous frame" onclick={() => setFrame($frame - 1)}><StepBackIcon /></Button>
    <Button size="icon-sm" title="Play / pause (Space)" aria-label={playing ? 'Pause' : 'Play'} onclick={togglePlay} disabled={exporting}>
      {#if playing}<PauseIcon />{:else}<PlayIcon />{/if}
    </Button>
    <Button variant="ghost" size="icon-sm" title="Next frame (.)" aria-label="Next frame" onclick={() => setFrame($frame + 1)}><StepForwardIcon /></Button>
    <Button variant="ghost" size="icon-sm" title="Last frame" aria-label="Last frame" onclick={() => setFrame(length)}><SkipForwardIcon /></Button>

    <Slider type="single" min={0} max={length} step={1} value={$frame} onValueChange={(v: number) => setFrame(v)} class="mx-2 flex-1" aria-label="Frame" />
    <span class="min-w-16 text-center text-xs tabular-nums">{$frame} / {length}</span>

    <label class="flex items-center gap-1.5 text-xs text-muted-foreground" title="Playback speed (frames per second, at most)">
      FPS <Input type="number" min={1} max={60} value={$fps} onchange={(e: Event & { currentTarget: HTMLInputElement }) => ($fps = Math.max(1, Number(e.currentTarget.value) || 1))} class={numberField} />
    </label>
    <label class="flex items-center gap-1.5 text-xs text-muted-foreground" title="Samples per frame before playback moves on">
      Preview spp <Input type="number" min={1} value={$playSamples} onchange={(e: Event & { currentTarget: HTMLInputElement }) => ($playSamples = Math.max(1, Number(e.currentTarget.value) || 1))} class={numberField} />
    </label>
    <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Switch checked={$loop} onCheckedChange={(c: boolean) => ($loop = c)} /> Loop
    </label>
    <label class="flex items-center gap-1.5 text-xs text-muted-foreground" title="Samples per frame when exporting">
      Export spp <Input type="number" min={1} value={$exportSamples} onchange={(e: Event & { currentTarget: HTMLInputElement }) => ($exportSamples = Math.max(1, Number(e.currentTarget.value) || 1))} class={numberField} />
    </label>
    <Button
      size="sm"
      variant={exporting ? 'destructive' : 'outline'}
      title="Render every frame to PNG (pick a folder in Chrome or Edge). Set Preview scale to 1 for full size."
      onclick={exportFrames}
    >
      {#if exporting}<XIcon />Cancel export{:else}<FilmIcon />Export frames{/if}
    </Button>
  </div>
{/if}
