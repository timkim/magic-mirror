<script lang="ts">
  // One control, built from a setting's definition. Every setting in the app gets its UI here.
  import type { SettingDef, Settings } from '../../core/settings';
  import { settingStore } from '../stores';

  let { settings, def }: { settings: Settings; def: SettingDef } = $props();
  const value = settingStore(settings, def.key);

  const toHex = (c: number[]) => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
  const fromHex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  const round = (n: number, k = 1000) => Math.round(n * k) / k;

  // Ranges and options can change at runtime (e.g. camera slots from the open file), so re-read
  // the definition whenever the value changes.
  let current = $derived.by(() => ({ v: $value, def }));
</script>

<label class="row" title={def.help} class:wide={def.type !== 'number'}>
  <span class="label">{def.label}</span>
  {#if current.def.type === 'number'}
    {@const d = current.def}
    <input type="range" min={d.min} max={d.max} step={d.step ?? 0.01} value={current.v} oninput={(e) => ($value = Number(e.currentTarget.value))} />
    <input type="number" min={d.min} max={d.max} step={d.step ?? 0.01} value={round(current.v as number)} oninput={(e) => ($value = Number(e.currentTarget.value))} />
  {:else if current.def.type === 'bool'}
    <input type="checkbox" checked={current.v as boolean} onchange={(e) => ($value = e.currentTarget.checked)} />
  {:else if current.def.type === 'color'}
    <input type="color" value={toHex(current.v as number[])} oninput={(e) => ($value = fromHex(e.currentTarget.value))} />
  {:else if current.def.type === 'select'}
    <select value={current.v} onchange={(e) => ($value = e.currentTarget.value)}>
      {#each current.def.options as o (o.value)}
        <option value={o.value}>{o.label}</option>
      {/each}
    </select>
  {:else if current.def.type === 'vec3'}
    {@const step = current.def.step ?? 0.1}
    <span class="vec3">
      {#each [0, 1, 2] as i (i)}
        <input
          type="number"
          {step}
          value={round((current.v as number[])[i], 100)}
          oninput={(e) => {
            const next = [...(current.v as number[])] as [number, number, number];
            next[i] = Number(e.currentTarget.value);
            $value = next;
          }}
        />
      {/each}
    </span>
  {/if}
</label>

<style>
  .row {
    display: grid;
    grid-template-columns: 96px 1fr auto;
    align-items: center;
    gap: 6px;
  }
  .row.wide {
    grid-template-columns: 96px 1fr;
  }
  .label {
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  input[type='range'] {
    width: 100%;
    accent-color: var(--accent);
  }
  input[type='number'] {
    width: 58px;
  }
  .vec3 {
    display: flex;
    gap: 4px;
  }
  .vec3 input {
    width: 100%;
    min-width: 0;
  }
  input[type='checkbox'] {
    justify-self: start;
    accent-color: var(--accent);
  }
  input[type='color'] {
    width: 100%;
    height: 22px;
    padding: 0;
    border: 1px solid var(--line);
    background: none;
  }
</style>
