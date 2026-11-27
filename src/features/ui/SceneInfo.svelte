<script lang="ts">
  // What's in the open file: models, voxels, bounds, materials, animation.
  import type { App } from '../../app';
  import { Badge } from '$lib/components/ui/badge';
  import { animationLength, placeModels } from '../../vox/scene';

  let { app }: { app: App } = $props();
  const scene = app.scene;

  let rows = $derived.by(() => {
    const s = $scene;
    if (!s) return null;
    const placed = placeModels(s.file);
    const len = animationLength(s.file);
    const r: [string, string][] = [
      ['Version', String(s.file.version)],
      ['Models', `${s.file.models.length} (${placed.length} placed)`],
      ['Voxels', s.grid.voxelCount.toLocaleString()],
      ['Bounds', s.grid.dims.join(' × ')],
      ['Storage', `${((s.grid.bricksUsed * 512 + s.grid.map.length * 4) / 1048576).toFixed(1)} MB (${s.grid.bricksUsed.toLocaleString()} bricks)`],
      ['Materials', String(s.file.materials.size)],
      ['Animation', len ? `${len + 1} frames` : 'static'],
    ];
    if (s.file.unknownChunks.length) r.push(['Other chunks', s.file.unknownChunks.join(', ')]);
    return { name: s.name, r };
  });
</script>

{#if rows}
  <div class="truncate text-sm font-medium" title={rows.name}>{rows.name}</div>
  <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
    {#each rows.r as [k, v] (k)}
      <dt class="text-muted-foreground">{k}</dt>
      <dd class="m-0 tabular-nums break-words">
        {#if k === 'Animation' && v !== 'static'}<Badge variant="secondary">{v}</Badge>{:else}{v}{/if}
      </dd>
    {/each}
  </dl>
{:else}
  <p class="m-0 text-xs text-muted-foreground">No scene loaded.</p>
{/if}
