<script lang="ts">
  // Edit panel: what a click does (Attach / Erase / Paint), the brush, mirroring and the model
  // being edited.
  import type { App } from '../../app';
  import * as ToggleGroup from '$lib/components/ui/toggle-group';
  import { Toggle } from '$lib/components/ui/toggle';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import type { Brush, EditMode } from '../../edit/editor';

  let { app }: { app: App } = $props();
  const ed = app.editor;
  const { enabled, mode, brush, mirror, selected } = ed;
  const scene = app.scene;

  let modeValue = $state<string>('attach');
  let brushValue = $state<string>('voxel');
  $effect(() => { modeValue = $mode; });
  $effect(() => { brushValue = $brush; });

  let size = $state([32, 32, 32]);
  let current = $derived.by(() => {
    void $scene;
    const i = $selected;
    if (i === null) return null;
    const p = app.editor.selectedPlacement();
    if (!p || !app.file) return null;
    return { name: p.name ?? `model ${p.modelId}`, size: app.file.models[p.modelId].size, id: p.modelId, i };
  });

  function addModel() {
    const t = app.settings.vec('cam.target');
    try {
      ed.addModel(size as [number, number, number], [t[0], t[1], Math.max(t[2], Math.floor(size[2] / 2) + (app.grid?.origin[2] ?? 0))], `model ${(app.file?.models.length ?? 0) + 1}`);
      enabled.set(true);
    } catch (e) {
      app.setStatus('msg', (e as Error).message);
    }
  }
</script>

{#if !$scene}
  <p class="m-0 text-xs text-muted-foreground">Open a .vox or press New in the toolbar to start building.</p>
{:else}
  <div class="grid gap-3 text-xs">
    <div class="grid gap-1.5">
      <Label class="text-xs text-muted-foreground">Click to</Label>
      <ToggleGroup.Root type="single" variant="outline" size="sm" bind:value={modeValue} onValueChange={(v) => v && mode.set(v as EditMode)}>
        <ToggleGroup.Item value="attach" title="Add voxels on the face you click (A)">Attach</ToggleGroup.Item>
        <ToggleGroup.Item value="erase" title="Remove voxels (E)">Erase</ToggleGroup.Item>
        <ToggleGroup.Item value="paint" title="Recolour voxels (P)">Paint</ToggleGroup.Item>
      </ToggleGroup.Root>
    </div>
    <div class="grid gap-1.5">
      <Label class="text-xs text-muted-foreground">Brush</Label>
      <ToggleGroup.Root type="single" variant="outline" size="sm" bind:value={brushValue} onValueChange={(v) => v && brush.set(v as Brush)}>
        <ToggleGroup.Item value="voxel" title="One voxel at a time; drag to draw (V)">Voxel</ToggleGroup.Item>
        <ToggleGroup.Item value="box" title="Drag out a rectangle (B)">Box</ToggleGroup.Item>
        <ToggleGroup.Item value="face" title="The whole same-coloured face you click (F)">Face</ToggleGroup.Item>
      </ToggleGroup.Root>
    </div>
    <div class="flex items-center gap-1.5">
      <Label class="mr-1 text-xs text-muted-foreground">Mirror</Label>
      {#each ['x', 'y', 'z'] as const as axis (axis)}
        <Toggle size="sm" variant="outline" pressed={$mirror[axis]} onPressedChange={(p) => mirror.update((m) => ({ ...m, [axis]: p }))} title="Mirror across the model's {axis.toUpperCase()} centre ({axis.toUpperCase()})">{axis.toUpperCase()}</Toggle>
      {/each}
    </div>

    <div class="grid gap-1.5 rounded-md border border-border p-2">
      {#if current}
        <div class="flex items-center justify-between gap-2">
          <span class="truncate font-medium" title={current.name}>{current.name}</span>
          <Button size="xs" variant="ghost" onclick={() => selected.set(null)} title="Stop editing this model (Esc)">Done</Button>
        </div>
        <span class="text-muted-foreground">{current.size.join(' × ')} voxels box · model {current.id}</span>
      {:else}
        <span class="text-muted-foreground">{$enabled ? 'Click a model to edit it.' : 'Turn on Edit (Tab), then click a model.'}</span>
      {/if}
      <span class="text-muted-foreground">Ctrl+click: another model · Alt+click: pick colour · right-drag: orbit</span>
    </div>

    <div class="grid gap-1.5">
      <Label class="text-xs text-muted-foreground">New model (size)</Label>
      <div class="flex gap-1">
        {#each [0, 1, 2] as i (i)}
          <Input type="number" min={1} max={256} class="h-7 px-1.5 text-xs" bind:value={size[i]} aria-label="Size {'XYZ'[i]}" />
        {/each}
        <Button size="sm" variant="outline" onclick={addModel} title="Add an empty model at the camera target">Add</Button>
      </div>
    </div>
  </div>
{/if}
