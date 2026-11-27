<script lang="ts">
  // Lays the reference image over the render: overlay (fade), wipe (split) or difference.
  import type { App } from '../../app';
  import { settingStore } from '../../ui/stores';
  import { reference } from '../compareState';

  let { app }: { app: App } = $props();
  const mode = settingStore<string>(app.settings, 'compare.mode');
  const amount = settingStore<number>(app.settings, 'compare.amount');
</script>

{#if $reference && $mode !== 'off'}
  <img
    src={$reference.url}
    alt="Reference"
    style:opacity={$mode === 'overlay' ? $amount : 1}
    style:mix-blend-mode={$mode === 'difference' ? 'difference' : 'normal'}
    style:clip-path={$mode === 'wipe' ? `inset(0 0 0 ${$amount * 100}%)` : 'none'}
  />
{/if}

<style>
  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
</style>
