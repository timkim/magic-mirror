<script lang="ts">
  // MagicaVoxel's layers: show or hide each one, rename it, and see how many objects it holds.
  import type { App } from '../../app';
  import { Button } from '$lib/components/ui/button';
  import EyeIcon from '@lucide/svelte/icons/eye';
  import EyeOffIcon from '@lucide/svelte/icons/eye-off';

  let { app }: { app: App } = $props();
  const scene = app.scene;
  const history = app.history.state;

  let rows = $derived.by(() => {
    void $scene;
    void $history;
    const file = app.file;
    if (!file) return [];
    const count = new Map<number, number>();
    const hidden: { id: number; name: string }[] = [];
    for (const n of file.nodes.values()) {
      if (n.kind !== 'transform' || file.nodes.get(n.childId)?.kind !== 'shape') continue;
      count.set(n.layerId, (count.get(n.layerId) ?? 0) + 1);
      if (n.attrs._hidden === '1') hidden.push({ id: n.id, name: n.attrs._name ?? `object ${n.id}` });
    }
    const layers = [...file.layers.values()].sort((a, b) => a.id - b.id).map((l) => ({ id: l.id, name: l.attrs._name ?? '', hidden: l.hidden, objects: count.get(l.id) ?? 0 }));
    return [{ layers, hidden }];
  });
</script>

{#if !$scene}
  <p class="m-0 text-xs text-muted-foreground">No scene loaded.</p>
{:else}
  {#each rows as r (0)}
    <div class="grid gap-0.5 text-xs">
      {#each r.layers as l (l.id)}
        <div class="flex items-center gap-1 {l.objects ? '' : 'opacity-50'}">
          <Button size="icon-xs" variant="ghost" title={l.hidden ? 'Show this layer' : 'Hide this layer'} aria-label={l.hidden ? `Show layer ${l.id}` : `Hide layer ${l.id}`}
            onclick={() => app.editor.setLayer(l.id, { hidden: !l.hidden }, `${l.hidden ? 'Show' : 'Hide'} ${l.name || `layer ${l.id}`}`)}>
            {#if l.hidden}<EyeOffIcon class="text-muted-foreground" />{:else}<EyeIcon />{/if}
          </Button>
          <input
            class="h-6 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 hover:border-input focus:border-input {l.hidden ? 'text-muted-foreground line-through' : ''}"
            value={l.name}
            placeholder="Layer {l.id}"
            aria-label="Name of layer {l.id}"
            onchange={(e) => app.editor.setLayer(l.id, { name: e.currentTarget.value.trim() }, 'Rename layer')}
          />
          <span class="shrink-0 text-right text-muted-foreground tabular-nums" title="{l.objects} objects">{l.objects}</span>
        </div>
      {/each}
      {#if r.hidden.length}
        <p class="mt-2 mb-0.5 text-muted-foreground">Hidden objects</p>
        {#each r.hidden as h (h.id)}
          <div class="flex items-center gap-1">
            <Button size="icon-xs" variant="ghost" title="Show this object" aria-label="Show {h.name}" onclick={() => app.editor.setObject(h.id, { hidden: false }, `Show ${h.name}`)}><EyeOffIcon class="text-muted-foreground" /></Button>
            <span class="truncate text-muted-foreground">{h.name}</span>
          </div>
        {/each}
      {/if}
    </div>
  {/each}
{/if}
