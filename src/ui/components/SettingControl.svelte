<script lang="ts">
  // One control, built from a setting's definition. Every setting in the app gets its UI here.
  import type { SettingDef, Settings } from '../../core/settings';
  import { settingStore } from '../stores';
  import { Slider } from '$lib/components/ui/slider';
  import { Input } from '$lib/components/ui/input';
  import { Switch } from '$lib/components/ui/switch';
  import * as NativeSelect from '$lib/components/ui/native-select';

  let { settings, def }: { settings: Settings; def: SettingDef } = $props();
  const value = settingStore(settings, def.key);
  const id = `setting-${def.key.replace(/\W/g, '-')}`;

  const toHex = (c: number[]) => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
  const fromHex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  const round = (n: number, k = 1000) => Math.round(n * k) / k;

  // Ranges and options can change at runtime (e.g. camera slots from the open file), so re-read
  // the definition whenever the value changes.
  let current = $derived.by(() => ({ v: $value, def }));
</script>

<div class="grid grid-cols-[92px_1fr] items-center gap-x-2" title={def.help}>
  <label for={id} class="truncate text-xs text-muted-foreground">{def.label}</label>
  {#if current.def.type === 'number'}
    {@const d = current.def}
    <div class="flex items-center gap-2">
      <Slider
        type="single"
        min={d.min}
        max={d.max}
        step={d.step ?? 0.01}
        value={current.v as number}
        onValueChange={(v: number) => ($value = v)}
        class="flex-1"
      />
      <Input
        {id}
        type="number"
        min={d.min}
        max={d.max}
        step={d.step ?? 0.01}
        value={round(current.v as number)}
        oninput={(e: Event & { currentTarget: HTMLInputElement }) => {
          const n = Number(e.currentTarget.value);
          if (Number.isFinite(n)) $value = n;
        }}
        class="h-7 w-16 px-1.5 text-xs tabular-nums"
      />
    </div>
  {:else if current.def.type === 'bool'}
    <Switch {id} checked={current.v as boolean} onCheckedChange={(c: boolean) => ($value = c)} />
  {:else if current.def.type === 'color'}
    <input
      {id}
      type="color"
      value={toHex(current.v as number[])}
      oninput={(e) => ($value = fromHex(e.currentTarget.value))}
      class="h-7 w-full cursor-pointer rounded-md border border-input bg-transparent p-0.5"
    />
  {:else if current.def.type === 'select'}
    <NativeSelect.Root {id} size="sm" class="w-full" value={current.v as string} onchange={(e: Event & { currentTarget: HTMLSelectElement }) => ($value = e.currentTarget.value)}>
      {#each current.def.options as o (o.value)}
        <NativeSelect.Option value={o.value}>{o.label}</NativeSelect.Option>
      {/each}
    </NativeSelect.Root>
  {:else if current.def.type === 'vec3'}
    {@const step = current.def.step ?? 0.1}
    <div class="grid grid-cols-3 gap-1">
      {#each [0, 1, 2] as i (i)}
        <Input
          id={i === 0 ? id : undefined}
          type="number"
          {step}
          aria-label="{def.label} {'xyz'[i]}"
          value={round((current.v as number[])[i], 100)}
          oninput={(e: Event & { currentTarget: HTMLInputElement }) => {
            const next = [...(current.v as number[])] as [number, number, number];
            next[i] = Number(e.currentTarget.value);
            $value = next;
          }}
          class="h-7 px-1.5 text-xs tabular-nums"
        />
      {/each}
    </div>
  {/if}
</div>
