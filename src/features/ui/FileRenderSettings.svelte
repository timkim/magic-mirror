<script lang="ts">
  // The raw render settings (rOBJ) and stored camera slots (rCAM) in the open file, for
  // mapping more of MagicaVoxel's look.
  import type { App } from '../../app';

  let { app }: { app: App } = $props();
  const scene = app.scene;

  let text = $derived.by(() => {
    const s = $scene;
    if (!s) return '';
    const cams = s.file.cameras.filter((c) => Number(c.attrs._radius) > 0 || Number(c.attrs._frustum) > 0);
    return (
      [...s.file.renderObjects.map((d) => JSON.stringify(d)), ...cams.map((c) => `rCAM ${c.id} ${JSON.stringify(c.attrs)}`)].join('\n') ||
      '(none stored)'
    );
  });
</script>

{#if text}
  <pre class="m-0 max-h-80 overflow-auto rounded-md bg-muted p-2 font-mono text-[10.5px] leading-snug break-all whitespace-pre-wrap text-muted-foreground">{text}</pre>
{:else}
  <p class="m-0 text-xs text-muted-foreground">No scene loaded.</p>
{/if}
