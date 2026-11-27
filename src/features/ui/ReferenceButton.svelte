<script lang="ts">
  import type { App } from '../../app';
  let { app }: { app: App } = $props();
  let input: HTMLInputElement;
</script>

<input
  bind:this={input}
  type="file"
  accept="image/*"
  hidden
  onchange={() => {
    if (input.files?.[0]) app.openFile(input.files[0]);
    input.value = '';
  }}
/>
<button type="button" title="Load a MagicaVoxel render to compare against (or drop an image)" onclick={() => input.click()}>Reference…</button>
