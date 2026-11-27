<script lang="ts">
  // Toolbar: open a .vox, load a built-in test scene, save the render as PNG.
  import type { App } from '../../app';
  import { Button } from '$lib/components/ui/button';
  import * as NativeSelect from '$lib/components/ui/native-select';
  import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
  import DownloadIcon from '@lucide/svelte/icons/download';

  let { app }: { app: App } = $props();
  const samples = import.meta.glob('../../../test-scenes/*.vox', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
  const scenes = Object.entries(samples).map(([path, url]) => ({ name: path.split('/').pop()!, url }));
  let input: HTMLInputElement;
  let pick = $state('');

  async function open(url: string) {
    pick = '';
    const scene = scenes.find((s) => s.url === url);
    if (!scene) return;
    const bytes = new Uint8Array(await (await fetch(scene.url)).arrayBuffer());
    app.openVox(bytes, scene.name);
  }
</script>

<input
  bind:this={input}
  type="file"
  accept=".vox"
  hidden
  onchange={() => {
    if (input.files?.[0]) app.openFile(input.files[0]);
    input.value = '';
  }}
/>
<Button size="sm" title="Or drop a .vox file anywhere" onclick={() => input.click()}><FolderOpenIcon />Open .vox</Button>
<NativeSelect.Root size="sm" aria-label="Test scenes" bind:value={pick} onchange={() => open(pick)}>
  <NativeSelect.Option value="">Test scenes…</NativeSelect.Option>
  {#each scenes as s (s.url)}<NativeSelect.Option value={s.url}>{s.name}</NativeSelect.Option>{/each}
</NativeSelect.Root>
<Button size="sm" variant="outline" title="Save the current render at the output size" onclick={() => app.savePng()}><DownloadIcon />Save PNG</Button>
