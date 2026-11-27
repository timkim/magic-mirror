<script lang="ts">
  // Edit panel: what a click does (Attach / Erase / Paint), the brush, mirroring and the model
  // being edited.
  import type { App } from '../../app';
  import * as ToggleGroup from '$lib/components/ui/toggle-group';
  import { Toggle } from '$lib/components/ui/toggle';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import * as NativeSelect from '$lib/components/ui/native-select';
  import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
  import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
  import EyeOffIcon from '@lucide/svelte/icons/eye-off';
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
  const history = app.history.state;
  let current = $derived.by(() => {
    void $scene;
    void $history;
    const id = $selected;
    if (id === null) return null;
    const p = app.editor.selectedPlacement();
    if (!p || !app.file || p.nodeId === undefined) return null;
    const node = app.file.nodes.get(p.nodeId);
    const layer = node?.kind === 'transform' ? node.layerId : 0;
    const animated = node?.kind === 'transform' && node.frames.some((f) => f.frame !== undefined);
    return { name: p.name ?? '', label: p.name ?? `model ${p.modelId}`, size: [...app.file.models[p.modelId].size], id: p.modelId, nodeId: p.nodeId, pos: [...p.translation], layer, animated };
  });
  let layers = $derived.by(() => {
    void $scene;
    void $history;
    return [...(app.file?.layers.values() ?? [])].sort((a, b) => a.id - b.id);
  });
  let newSize = $state([0, 0, 0]);
  let anchor = $state('corner');
  $effect(() => {
    if (current) newSize = [...current.size];
  });

  function setPos(axis: number, value: number) {
    if (!current || !Number.isFinite(value)) return;
    const d: [number, number, number] = [0, 0, 0];
    d[axis] = Math.round(value) - current.pos[axis];
    ed.moveObject(current.nodeId, d, `Move ${current.label}`);
  }
  function resize() {
    if (!current) return;
    const ns = newSize.map((v) => Math.max(1, Math.min(256, Math.round(v)))) as [number, number, number];
    // Where the old voxels sit in the new box: at its corner, centred, or centred on the ground.
    const off = ns.map((v, i) => (anchor === 'corner' ? 0 : anchor === 'bottom' && i === 2 ? 0 : Math.floor((v - current!.size[i]) / 2))) as [number, number, number];
    const r = ed.resizeModel(current.id, ns, off, `Resize ${current.label} to ${ns.join('×')}`);
    if (r.cut) app.setStatus('msg', `Resized; ${r.cut} voxels outside the new box were cut (undo to bring them back)`);
  }

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
  <div class="grid min-w-0 gap-3 text-xs">
    <div class="grid gap-1.5">
      <Label class="text-xs text-muted-foreground">Click to</Label>
      <ToggleGroup.Root type="single" variant="outline" size="sm" bind:value={modeValue} onValueChange={(v) => v && mode.set(v as EditMode)}>
        <ToggleGroup.Item value="attach" title="Add voxels on the face you click (A)">Attach</ToggleGroup.Item>
        <ToggleGroup.Item value="erase" title="Remove voxels (E)">Erase</ToggleGroup.Item>
        <ToggleGroup.Item value="paint" title="Recolour voxels (P)">Paint</ToggleGroup.Item>
        <ToggleGroup.Item value="move" title="Drag a model along the ground; Shift+drag moves it up and down (M)">Move</ToggleGroup.Item>
      </ToggleGroup.Root>
    </div>
    <div class="grid gap-1.5" class:hidden={$mode === 'move'}>
      <Label class="text-xs text-muted-foreground">Brush</Label>
      <ToggleGroup.Root type="single" variant="outline" size="sm" bind:value={brushValue} onValueChange={(v) => v && brush.set(v as Brush)}>
        <ToggleGroup.Item value="voxel" title="One voxel at a time; drag to draw (V)">Voxel</ToggleGroup.Item>
        <ToggleGroup.Item value="box" title="Drag out a rectangle (B)">Box</ToggleGroup.Item>
        <ToggleGroup.Item value="face" title="The whole same-coloured face you click (F)">Face</ToggleGroup.Item>
        <ToggleGroup.Item value="line" title="Drag a line (L)">Line</ToggleGroup.Item>
        <ToggleGroup.Item value="sphere" title="Drag out a ball from its centre (S)">Sphere</ToggleGroup.Item>
      </ToggleGroup.Root>
    </div>
    <div class="flex items-center gap-1.5" class:hidden={$mode === 'move'}>
      <Label class="mr-1 text-xs text-muted-foreground">Mirror</Label>
      {#each ['x', 'y', 'z'] as const as axis (axis)}
        <Toggle size="sm" variant="outline" pressed={$mirror[axis]} onPressedChange={(p) => mirror.update((m) => ({ ...m, [axis]: p }))} title="Mirror across the model's {axis.toUpperCase()} centre ({axis.toUpperCase()})">{axis.toUpperCase()}</Toggle>
      {/each}
    </div>

    <div class="grid min-w-0 gap-1.5 rounded-md border border-border p-2">
      {#if current}
        <div class="flex min-w-0 items-center justify-between gap-1">
          <input
            class="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 font-medium hover:border-input focus:border-input"
            value={current.name}
            placeholder={current.label}
            aria-label="Object name"
            onchange={(e) => ed.setObject(current!.nodeId, { name: e.currentTarget.value.trim() }, 'Rename object')}
          />
          <Button size="icon-xs" variant="ghost" title="Hide this object" aria-label="Hide object" onclick={() => { ed.setObject(current!.nodeId, { hidden: true }, `Hide ${current!.label}`); selected.set(null); }}><EyeOffIcon /></Button>
          <Button size="xs" variant="ghost" onclick={() => selected.set(null)} title="Stop editing this model (Esc)">Done</Button>
        </div>
        <span class="text-muted-foreground">model {current.id}{current.animated ? ' · animated: moving shifts every keyframe' : ''}</span>
        <div class="grid min-w-0 grid-cols-[52px_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
          <span class="text-muted-foreground">Position</span>
          <div class="flex gap-1">
            {#each [0, 1, 2] as i (i)}
              <Input type="number" class="h-7 min-w-0 px-1 text-xs" value={current.pos[i]} aria-label="Position {'XYZ'[i]}" onchange={(e: Event & { currentTarget: HTMLInputElement }) => setPos(i, Number(e.currentTarget.value))} />
            {/each}
          </div>
          <span class="text-muted-foreground">Rotate</span>
          <div class="flex gap-1">
            <Button size="xs" variant="outline" title="Turn 90° counter-clockwise (Shift+R)" onclick={() => ed.rotateObject(current!.nodeId, 1, `Rotate ${current!.label}`)}><RotateCcwIcon />90°</Button>
            <Button size="xs" variant="outline" title="Turn 90° clockwise (R)" onclick={() => ed.rotateObject(current!.nodeId, -1, `Rotate ${current!.label}`)}><RotateCwIcon />90°</Button>
          </div>
          <span class="text-muted-foreground">Size</span>
          <div class="flex gap-1">
            {#each [0, 1, 2] as i (i)}
              <Input type="number" min={1} max={256} class="h-7 min-w-0 px-1 text-xs" bind:value={newSize[i]} aria-label="Size {'XYZ'[i]}" />
            {/each}
          </div>
          <span></span>
          <div class="flex min-w-0 gap-1">
            <NativeSelect.Root size="sm" class="min-w-0 flex-1" bind:value={anchor} aria-label="Where existing voxels go" title="Where the existing voxels sit in the new box">
              <NativeSelect.Option value="corner">Corner</NativeSelect.Option>
              <NativeSelect.Option value="bottom">Bottom</NativeSelect.Option>
              <NativeSelect.Option value="centre">Centre</NativeSelect.Option>
            </NativeSelect.Root>
            <Button size="xs" variant="outline" disabled={newSize.every((v, i) => v === current!.size[i])} onclick={resize}>Resize</Button>
          </div>
          <span class="text-muted-foreground">Layer</span>
          <NativeSelect.Root size="sm" class="min-w-0" value={String(current.layer)} aria-label="Layer" onchange={(e: Event & { currentTarget: HTMLSelectElement }) => ed.setObject(current!.nodeId, { layer: Number(e.currentTarget.value) }, 'Move to layer')}>
            {#each layers as l (l.id)}<NativeSelect.Option value={String(l.id)}>{l.attrs._name || `Layer ${l.id}`}</NativeSelect.Option>{/each}
          </NativeSelect.Root>
        </div>
      {:else}
        <span class="text-muted-foreground">{$enabled ? 'Click a model to edit it.' : 'Turn on Edit (Tab), then click a model.'}</span>
      {/if}
      <span class="text-muted-foreground">Ctrl+click: another model · Alt+click: pick colour · right-drag: orbit</span>
    </div>

    <div class="grid gap-1.5">
      <Label class="text-xs text-muted-foreground">New model (size)</Label>
      <div class="flex min-w-0 gap-1">
        {#each [0, 1, 2] as i (i)}
          <Input type="number" min={1} max={256} class="h-7 min-w-0 px-1 text-xs" bind:value={size[i]} aria-label="Size {'XYZ'[i]}" />
        {/each}
        <Button size="sm" variant="outline" onclick={addModel} title="Add an empty model at the camera target">Add</Button>
      </div>
    </div>
  </div>
{/if}
