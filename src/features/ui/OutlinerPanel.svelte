<script lang="ts">
  // The scene's tree of groups and objects. Click to select (and edit), double-click to frame the
  // camera on it; hide, duplicate or delete from each row. Ctrl+C / Ctrl+V / Ctrl+D / Delete work
  // on the selection too (see EditToolbar).
  import type { App } from '../../app';
  import { Button } from '$lib/components/ui/button';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import BoxIcon from '@lucide/svelte/icons/box';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import EyeIcon from '@lucide/svelte/icons/eye';
  import EyeOffIcon from '@lucide/svelte/icons/eye-off';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import TrashIcon from '@lucide/svelte/icons/trash-2';
  import { placementBounds } from '../../vox/scene';

  let { app }: { app: App } = $props();
  const ed = app.editor;
  const scene = app.scene;
  const history = app.history.state;
  const selected = ed.selected;
  let expanded = $state(new Set<number>());
  let filter = $state('');

  interface Row { id: number; name: string; group: boolean; depth: number; hidden: boolean; dim: boolean; kids: number; animated: boolean; open: boolean }

  let rows = $derived.by(() => {
    void $scene;
    void $history;
    const file = app.file;
    const out: Row[] = [];
    if (!file) return out;
    const top = file.nodes.get(0);
    const topGroup = top?.kind === 'transform' ? file.nodes.get(top.childId) : undefined;
    if (topGroup?.kind !== 'group') return out;
    const q = filter.trim().toLowerCase();
    const visit = (id: number, depth: number, parentHidden: boolean) => {
      const t = file.nodes.get(id);
      if (t?.kind !== 'transform') return;
      const child = file.nodes.get(t.childId);
      const group = child?.kind === 'group';
      const model = child?.kind === 'shape' ? child.models[0]?.modelId : undefined;
      const name = t.attrs._name ?? (group ? `group ${id}` : `model ${model}`);
      const hidden = t.attrs._hidden === '1';
      const dim = parentHidden || hidden || !!file.layers.get(t.layerId)?.hidden;
      const open = expanded.has(id) || !!q;
      const kids = group ? child.childIds.length : 0;
      const animated = t.frames.length > 1 || (child?.kind === 'shape' && child.models.length > 1);
      if (!q || name.toLowerCase().includes(q) || group) out.push({ id, name, group, depth, hidden, dim, kids, animated, open });
      if (group && open) for (const c of child.childIds) visit(c, depth + 1, dim);
    };
    for (const c of topGroup.childIds) visit(c, 0, false);
    return q ? out.filter((r, i) => !r.group || r.name.toLowerCase().includes(q) || out[i + 1]?.depth > r.depth) : out;
  });

  function toggle(id: number) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  function pick(id: number) {
    ed.enabled.set(true);
    ed.select(id);
  }

  /** Point the camera at the selection. */
  function frame(id: number) {
    pick(id);
    const ps = ed.selectionPlacements();
    if (!ps.length || !app.file) return;
    const bs = ps.map((p) => placementBounds(app.file!, p));
    const lo = [0, 1, 2].map((i) => Math.min(...bs.map((b) => b.lo[i]))), hi = [0, 1, 2].map((i) => Math.max(...bs.map((b) => b.hi[i])));
    const s = app.settings;
    const r = Math.hypot(hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1) / 2;
    s.set('cam.target', [0, 1, 2].map((i) => (lo[i] + hi[i] + 1) / 2) as [number, number, number]);
    s.set('cam.distance', Math.max(4, (r / Math.sin((s.num('cam.fov') * Math.PI) / 360)) * 0.9));
    s.set('cam.orthoSize', Math.max(4, r * 2.4));
  }
</script>

{#if !$scene}
  <p class="m-0 text-xs text-muted-foreground">No scene loaded.</p>
{:else}
  <div class="grid min-w-0 gap-1.5 text-xs">
    <input bind:value={filter} placeholder="Find by name" aria-label="Find objects by name" class="h-7 min-w-0 rounded-md border border-input bg-transparent px-2" />
    <div class="max-h-80 min-w-0 overflow-y-auto" role="tree" aria-label="Scene objects">
      {#each rows as r (r.id)}
        <div
          role="treeitem"
          aria-selected={$selected === r.id}
          aria-expanded={r.group ? r.open : undefined}
          tabindex="-1"
          class="group/row flex h-6 min-w-0 cursor-default items-center gap-1 rounded pr-0.5 {$selected === r.id ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'} {r.dim ? 'opacity-50' : ''}"
          style:padding-left="{r.depth * 12}px"
          onclick={() => pick(r.id)}
          ondblclick={() => frame(r.id)}
          onkeydown={(e) => e.key === 'Enter' && pick(r.id)}
          title={`${r.name} (id ${r.id})${r.animated ? ' · animated' : ''} · double-click to frame it`}
        >
          {#if r.group}
            <button type="button" class="grid size-4 shrink-0 place-items-center text-muted-foreground" aria-label={r.open ? 'Collapse' : 'Expand'} onclick={(e) => { e.stopPropagation(); toggle(r.id); }}>
              <ChevronRightIcon class="size-3 transition-transform {r.open ? 'rotate-90' : ''}" />
            </button>
            <FolderIcon class="size-3.5 shrink-0 text-muted-foreground" />
          {:else}
            <span class="size-4 shrink-0"></span>
            <BoxIcon class="size-3.5 shrink-0 text-muted-foreground" />
          {/if}
          <span class="min-w-0 flex-1 truncate">{r.name}</span>
          {#if r.group}<span class="text-muted-foreground tabular-nums">{r.kids}</span>{/if}
          {#if r.animated}<span class="text-amber-500" title="Animated">◆</span>{/if}
          <span class="hidden shrink-0 group-hover/row:flex">
            <Button size="icon-xs" variant="ghost" title="Duplicate (Ctrl+D)" aria-label="Duplicate {r.name}" onclick={(e: MouseEvent) => { e.stopPropagation(); ed.duplicate(r.id); }}><CopyIcon /></Button>
            <Button size="icon-xs" variant="ghost" title="Delete (Delete)" aria-label="Delete {r.name}" onclick={(e: MouseEvent) => { e.stopPropagation(); ed.deleteObject(r.id); }}><TrashIcon /></Button>
          </span>
          <Button size="icon-xs" variant="ghost" class="shrink-0" title={r.hidden ? 'Show' : 'Hide'} aria-label={r.hidden ? `Show ${r.name}` : `Hide ${r.name}`}
            onclick={(e: MouseEvent) => { e.stopPropagation(); ed.setObject(r.id, { hidden: !r.hidden }, `${r.hidden ? 'Show' : 'Hide'} ${r.name}`); }}>
            {#if r.hidden}<EyeOffIcon />{:else}<EyeIcon class="opacity-40 group-hover/row:opacity-100" />{/if}
          </Button>
        </div>
      {/each}
      {#if !rows.length}<p class="m-0 p-1 text-muted-foreground">{filter ? 'Nothing matches.' : 'The scene is empty.'}</p>{/if}
    </div>
  </div>
{/if}
