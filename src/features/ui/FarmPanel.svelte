<script lang="ts">
  // Magic Prism farm panel: send the open animation to the coordinator, watch progress, and let
  // this tab join the farm as a worker.
  import { onMount } from 'svelte';
  import type { App } from '../../app';
  import { farmMessage, farmStatus, farmUrl, joined, saveSettings, sendJob, setJoined, videoUrl, watchStatus } from '../farmClient';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Switch } from '$lib/components/ui/switch';
  import { Badge } from '$lib/components/ui/badge';
  import { Progress } from '$lib/components/ui/progress';
  import SendIcon from '@lucide/svelte/icons/send';
  import FileJsonIcon from '@lucide/svelte/icons/file-json';

  let { app }: { app: App } = $props();
  const scene = app.scene;

  let first = $state(0);
  let last = $state(0);
  let samples = $state(app.settings.num('anim.exportSamples'));
  let scale = $state(1);
  let sending = $state(false);

  $effect(() => {
    if ($scene) {
      first = 0;
      last = app.animationEnd();
    }
  });

  onMount(() => watchStatus());

  let online = $derived(typeof $farmStatus === 'object' && $farmStatus ? $farmStatus.workers.filter((w) => w.online) : []);
  let jobs = $derived(typeof $farmStatus === 'object' && $farmStatus ? $farmStatus.jobs.slice(-5).reverse() : []);

  function eta(j: { total: number; done: number; avgFrameMs: number | null }) {
    if (!j.avgFrameMs || !online.length) return '';
    return ` · ~${Math.ceil(((j.total - j.done) * j.avgFrameMs) / online.length / 60000)} min`;
  }

  async function send() {
    sending = true;
    await sendJob(app, { firstFrame: first, lastFrame: last, samples, scale });
    sending = false;
  }

  const row = 'grid grid-cols-[92px_1fr] items-center gap-x-2';
  const label = 'text-xs text-muted-foreground';
  const num = 'h-7 px-1.5 text-xs tabular-nums';
</script>

<div class={row} title="Address of the PC running 'npm run farm'">
  <label for="farm-url" class={label}>Coordinator</label>
  <Input id="farm-url" class="h-7 text-xs" bind:value={$farmUrl} />
</div>
<div class={row}>
  <label for="farm-first" class={label}>Frames</label>
  <div class="grid grid-cols-2 gap-1">
    <Input id="farm-first" type="number" min={0} bind:value={first} class={num} aria-label="First frame" />
    <Input type="number" min={0} bind:value={last} class={num} aria-label="Last frame" />
  </div>
</div>
<div class={row} title="Samples per frame">
  <label for="farm-spp" class={label}>Samples</label>
  <Input id="farm-spp" type="number" min={1} bind:value={samples} class={num} />
</div>
<div class={row} title="1 = full output resolution">
  <label for="farm-scale" class={label}>Scale</label>
  <Input id="farm-scale" type="number" min={0.1} max={1} step={0.05} bind:value={scale} class={num} />
</div>
<div class="grid grid-cols-2 gap-1.5">
  <Button size="sm" onclick={send} disabled={sending || !$scene}><SendIcon />Send to farm</Button>
  <Button size="sm" variant="outline" onclick={() => saveSettings(app)} title="Save every setting as JSON, for: prism render scene.vox out.png --settings settings.json">
    <FileJsonIcon />Save settings
  </Button>
</div>
<div class={row} title="Render frames for the farm in this tab (keep it visible)">
  <label for="farm-join" class={label}>Join as worker</label>
  <Switch id="farm-join" checked={$joined} onCheckedChange={(c: boolean) => setJoined(app, c)} />
</div>

<div class="flex flex-col gap-2 rounded-md bg-muted/50 p-2 text-xs">
  {#if $farmMessage}<div>{$farmMessage}</div>{/if}
  {#if $farmStatus === 'unreachable'}
    <div class="text-muted-foreground">Farm not reachable.</div>
  {:else if $farmStatus === null}
    <div class="text-muted-foreground">Connecting…</div>
  {:else}
    <div class="flex items-center gap-1.5 text-muted-foreground">
      <Badge variant={online.length ? 'default' : 'secondary'}>{online.length}</Badge>
      worker{online.length === 1 ? '' : 's'} online
    </div>
    {#each jobs as j (j.id)}
      <div class="flex flex-col gap-1">
        <div class="flex items-center justify-between gap-2">
          <span class="truncate font-medium" title={j.name}>{j.name}</span>
          <span class="shrink-0 text-muted-foreground tabular-nums">
            {#if j.status === 'active'}{j.done}/{j.total}{eta(j)}{:else}{j.status}{/if}
            {#if j.video}· <a class="text-primary underline-offset-2 hover:underline" href={videoUrl(j.id, j.video)} target="_blank" rel="noreferrer">video</a>{/if}
          </span>
        </div>
        {#if j.status === 'active'}<Progress value={(100 * j.done) / Math.max(1, j.total)} class="h-1" />{/if}
      </div>
    {:else}
      <div class="text-muted-foreground">No jobs yet.</div>
    {/each}
  {/if}
</div>
