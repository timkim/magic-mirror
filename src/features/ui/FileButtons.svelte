<script lang="ts">
  // Toolbar: open a .vox, load a built-in test scene, save the render as PNG.
  import type { App } from '../../app';

  let { app }: { app: App } = $props();
  const samples = import.meta.glob('../../../test-scenes/*.vox', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
  const scenes = Object.entries(samples).map(([path, url]) => ({ name: path.split('/').pop()!, url }));
  let input: HTMLInputElement;

  async function pick(e: Event & { currentTarget: HTMLSelectElement }) {
    const sel = e.currentTarget;
    const scene = scenes.find((s) => s.url === sel.value);
    sel.value = '';
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
<button type="button" title="Or drop a .vox file anywhere" onclick={() => input.click()}>Open .vox</button>
<select onchange={pick} aria-label="Test scenes">
  <option value="">Test scenes…</option>
  {#each scenes as s (s.url)}<option value={s.url}>{s.name}</option>{/each}
</select>
<button type="button" title="Save the current render at the output size" onclick={() => app.savePng()}>Save PNG</button>
