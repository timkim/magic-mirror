<script lang="ts">
  // The palette (colour indices 1-255) and the material of the selected colour.
  // Edits go through app.editor, so they're undoable and saved into the .vox.
  import type { App } from '../../app';
  import { Slider } from '$lib/components/ui/slider';
  import * as NativeSelect from '$lib/components/ui/native-select';
  import type { VoxDict } from '../../vox/types';

  let { app }: { app: App } = $props();
  const ed = app.editor;
  const { color } = ed;
  const scene = app.scene;
  const history = app.history.state;

  const hex = (p: Uint8Array, i: number) => '#' + Array.from(p.subarray(i * 4, i * 4 + 3), (v) => v.toString(16).padStart(2, '0')).join('');
  let swatches = $derived.by(() => {
    void $history; // re-read after colour edits and undo
    const s = $scene;
    if (!s) return [];
    return Array.from({ length: 255 }, (_, k) => ({ i: k + 1, hex: hex(s.file.palette, k + 1) }));
  });
  let used = $derived.by(() => {
    void $history;
    const s = $scene;
    const u = new Set<number>();
    if (s) for (const m of s.file.models) for (let i = 3; i < m.voxels.length; i += 4) u.add(m.voxels[i]);
    return u;
  });
  let mat = $derived.by(() => {
    void $history;
    return ($scene?.file.materials.get($color) ?? {}) as VoxDict;
  });
  let type = $derived(mat._type ?? '_diffuse');

  const fields: Record<string, { key: string; label: string; min: number; max: number; def: number }[]> = {
    _metal: [
      { key: '_metal', label: 'Metal', min: 0, max: 1, def: 1 },
      { key: '_rough', label: 'Rough', min: 0, max: 1, def: 0.1 },
    ],
    _glass: [
      { key: '_trans', label: 'Transparent', min: 0, max: 1, def: 1 },
      { key: '_rough', label: 'Rough', min: 0, max: 1, def: 0.1 },
      { key: '_ri', label: 'IOR', min: 1, max: 3, def: 1.3 },
      { key: '_d', label: 'Density', min: 0, max: 1, def: 0 },
    ],
    _emit: [
      { key: '_emit', label: 'Emission', min: 0, max: 1, def: 0.5 },
      { key: '_flux', label: 'Power', min: 0, max: 4, def: 1 },
    ],
  };

  function setType(t: string) {
    const d: VoxDict = { ...mat, _type: t };
    for (const f of fields[t] ?? []) if (d[f.key] === undefined) d[f.key] = String(f.def);
    ed.setMaterial($color, d, `Colour ${$color}: ${t.slice(1)}`);
  }
  function setField(key: string, v: number) {
    ed.setMaterial($color, { ...mat, _type: type, [key]: String(Math.round(v * 1000) / 1000) }, `Colour ${$color}: ${key.slice(1)}`);
  }
  function setRgb(h: string) {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    ed.setColor($color, [c[0], c[1], c[2], 255]);
  }
</script>

{#if !$scene}
  <p class="m-0 text-xs text-muted-foreground">No scene loaded.</p>
{:else}
  <div class="grid gap-3 text-xs">
    <div class="grid grid-cols-16 gap-px rounded-md border border-border p-px" role="listbox" aria-label="Palette">
      {#each swatches as s (s.i)}
        <button
          type="button"
          role="option"
          aria-selected={$color === s.i}
          class="relative aspect-square min-w-0 {$color === s.i ? 'z-10 outline-2 outline-offset-0 outline-white ring-2 ring-black' : ''}"
          style:background={s.hex}
          title="Colour {s.i}{used.has(s.i) ? '' : ' (unused)'}"
          onclick={() => color.set(s.i)}
        >
          {#if used.has(s.i) && $color !== s.i}<span class="absolute right-0 bottom-0 size-1 bg-black/60"></span>{/if}
        </button>
      {/each}
    </div>

    <div class="grid grid-cols-[92px_1fr] items-center gap-x-2 gap-y-2">
      <span class="text-muted-foreground">Colour {$color}</span>
      <input type="color" value={swatches[$color - 1]?.hex} onchange={(e) => setRgb(e.currentTarget.value)} class="h-7 w-full cursor-pointer rounded-md border border-input bg-transparent p-0.5" aria-label="Edit colour {$color}" />
      <span class="text-muted-foreground">Material</span>
      <NativeSelect.Root size="sm" value={type} onchange={(e: Event & { currentTarget: HTMLSelectElement }) => setType(e.currentTarget.value)} aria-label="Material type">
        {#each [['_diffuse', 'Diffuse'], ['_metal', 'Metal'], ['_glass', 'Glass'], ['_emit', 'Emit'], ['_blend', 'Blend'], ['_media', 'Cloud / media']] as [v, l] (v)}
          <NativeSelect.Option value={v}>{l}</NativeSelect.Option>
        {/each}
      </NativeSelect.Root>
      {#each fields[type] ?? [] as f (f.key)}
        <span class="text-muted-foreground">{f.label}</span>
        <div class="flex items-center gap-2">
          <Slider type="single" min={f.min} max={f.max} step={0.01} value={Number(mat[f.key] ?? f.def)} onValueCommit={(v: number) => setField(f.key, v)} class="flex-1" />
          <span class="w-9 text-right tabular-nums">{Number(mat[f.key] ?? f.def).toFixed(2)}</span>
        </div>
      {/each}
    </div>
  </div>
{/if}
