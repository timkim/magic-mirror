<script lang="ts">
  import type { App } from '../../app';
  import { Button } from '$lib/components/ui/button';
  import ImageIcon from '@lucide/svelte/icons/image';
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
<Button size="sm" variant="outline" title="Load a MagicaVoxel render to compare against (or drop an image)" onclick={() => input.click()}><ImageIcon />Reference</Button>
