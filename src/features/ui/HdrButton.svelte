<script lang="ts">
  import type { App } from '../../app';
  import { Button } from '$lib/components/ui/button';
  import SunMediumIcon from '@lucide/svelte/icons/sun-medium';
  let { app }: { app: App } = $props();
  let input: HTMLInputElement;
</script>

<input
  bind:this={input}
  type="file"
  accept=".hdr"
  hidden
  onchange={() => {
    if (input.files?.[0]) app.openFile(input.files[0]);
    input.value = '';
  }}
/>
<Button size="sm" variant="outline" title="Load an equirectangular .hdr image to light the scene (or drop one)" onclick={() => input.click()}><SunMediumIcon />HDR sky</Button>
