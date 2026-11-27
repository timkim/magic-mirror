<script lang="ts">
  // The asset library: starter pieces and your own. Click a piece to place it at the camera
  // target, or drag it onto the scene to drop it where you point (on top of whatever is there).
  import { onMount } from 'svelte';
  import type { App } from '../../app';
  import { download } from '../../app';
  import { Button } from '$lib/components/ui/button';
  import * as NativeSelect from '$lib/components/ui/native-select';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import TrashIcon from '@lucide/svelte/icons/trash-2';
  import { assets, assetVox, libraryError, loadLibrary, place, removeFromLibrary, saveToLibrary, thumbnail, type Asset } from '../../library/library';

  let { app }: { app: App } = $props();
  const selected = app.editor.selected;
  const scene = app.scene;
  let q = $state('');
  let category = $state('All');
  let saving = $state(false);
  let saveName = $state('');
  let thumbs = $state<Record<string, string>>({});

  onMount(() => void loadLibrary());

  let categories = $derived(['All', ...new Set($assets.map((a) => a.category))]);
  let shown = $derived(
    $assets.filter((a) => (category === 'All' || a.category === category) && (!q.trim() || `${a.name} ${a.id} ${a.tags?.join(' ') ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))),
  );
  $effect(() => {
    for (const a of shown) if (!thumbs[a.id]) thumbnail(a).then((t) => (thumbs = { ...thumbs, [a.id]: t }), () => {});
  });

  async function placeAtTarget(a: Asset) {
    const t = app.settings.vec('cam.target');
    try {
      await place(app, a, [t[0], t[1]]);
    } catch (e) {
      app.setStatus('msg', (e as Error).message);
    }
  }
  async function save() {
    const id = $selected;
    if (id === null || !saveName.trim()) return;
    const a = await saveToLibrary(app, id, saveName.trim());
    app.setStatus('msg', `Saved ${a.name} to your library`);
    saving = false;
    saveName = '';
    category = 'My assets';
  }
  async function exportVox(a: Asset) {
    download(new Blob([(await assetVox(a)) as Uint8Array<ArrayBuffer>]), `${a.source === 'starter' ? a.id : a.name.replace(/[^\w.-]+/g, '_')}.vox`);
  }
</script>

<div class="grid min-w-0 gap-2 text-xs">
  <div class="flex min-w-0 gap-1">
    <input bind:value={q} placeholder="Search" aria-label="Search the library" class="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2" />
    <NativeSelect.Root size="sm" class="w-28" bind:value={category} aria-label="Category">
      {#each categories as c (c)}<NativeSelect.Option value={c}>{c}</NativeSelect.Option>{/each}
    </NativeSelect.Root>
  </div>
  {#if $libraryError}<p class="m-0 text-red-400">{$libraryError}</p>{/if}
  <div class="grid max-h-96 grid-cols-3 gap-1.5 overflow-y-auto" role="list" aria-label="Assets">
    {#each shown as a (a.id)}
      <div
        role="listitem"
        class="group/card relative grid min-w-0 cursor-grab gap-0.5 rounded-md border border-border p-1 hover:border-ring"
        draggable="true"
        ondragstart={(e) => { e.dataTransfer?.setData('application/x-magic-mirror-asset', a.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'; }}
        title="{a.name}{a.size ? ` · ${a.size.join('×')}` : ''}{a.description ? `\n${a.description}` : ''}\nClick to place at the camera target, or drag onto the scene"
      >
        <button type="button" class="aspect-square w-full rounded bg-muted/40" onclick={() => placeAtTarget(a)} aria-label="Place {a.name}">
          {#if thumbs[a.id]}<img src={thumbs[a.id]} alt="" class="size-full object-contain" draggable="false" />{/if}
        </button>
        <span class="truncate">{a.name}</span>
        <span class="hidden gap-0.5 group-hover/card:flex absolute top-1 right-1">
          <Button size="icon-xs" variant="secondary" title="Download as .vox" aria-label="Download {a.name}" onclick={() => exportVox(a)}><DownloadIcon /></Button>
          {#if a.source === 'mine'}<Button size="icon-xs" variant="secondary" title="Remove from your library" aria-label="Remove {a.name}" onclick={() => removeFromLibrary(a)}><TrashIcon /></Button>{/if}
        </span>
      </div>
    {/each}
    {#if !shown.length}<p class="col-span-3 m-0 text-muted-foreground">Nothing here yet.</p>{/if}
  </div>
  {#if saving}
    <div class="flex min-w-0 gap-1">
      <input bind:value={saveName} placeholder="Name" aria-label="Asset name" class="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2" onkeydown={(e) => e.key === 'Enter' && save()} />
      <Button size="sm" onclick={save} disabled={!saveName.trim()}>Save</Button>
      <Button size="sm" variant="ghost" onclick={() => (saving = false)}>Cancel</Button>
    </div>
  {:else}
    <Button size="sm" variant="outline" disabled={$selected === null || !$scene} title="Save the selected object or group as a reusable asset" onclick={() => { saving = true; saveName = app.file?.nodes.get($selected!)?.attrs._name ?? ''; }}><PlusIcon />Add selection to library</Button>
  {/if}
</div>
