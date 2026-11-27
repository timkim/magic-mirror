<script lang="ts">
  // Magic Mirror's shell: toolbar, two side columns of panels, the render view, a bottom strip
  // and the status bar. Features fill it: their settings become panels automatically and their
  // components land in the slot they ask for (see src/core/feature.ts).
  import type { App } from '../app';
  import type { SettingGroup } from '../core/settings';
  import type { UiContribution } from '../core/feature';
  import Panel from './components/Panel.svelte';
  import SettingControl from './components/SettingControl.svelte';
  import Viewport from './components/Viewport.svelte';

  let { app }: { app: App } = $props();
  const status = app.status;

  type Item = { order: number; group?: SettingGroup; ui?: UiContribution };
  function column(side: 'left' | 'right'): Item[] {
    const groups = app.settings.groups.filter((g) => !g.hidden && (g.slot ?? 'right') === side).map((group) => ({ order: 0, group }));
    const panels = app.ui(side).map((ui) => ({ order: ui.order ?? 0, ui }));
    // Stable sort keeps settings in registration order among equals.
    return [...groups, ...panels].map((x, i) => ({ ...x, i })).sort((a, b) => a.order - b.order || a.i - b.i);
  }
  const left = column('left');
  const right = column('right');
  const toolbar = app.ui('toolbar');
  const bottom = app.ui('bottom');
</script>

{#snippet columnPanels(items: Item[])}
  {#each items as item, i (i)}
    {#if item.group}
      <Panel title={item.group.label}>
        {#each item.group.defs as def (def.key)}
          <SettingControl settings={app.settings} {def} />
        {/each}
      </Panel>
    {:else if item.ui}
      <Panel title={item.ui.title ?? ''} collapsed={item.ui.collapsed}>
        <item.ui.component {app} />
      </Panel>
    {/if}
  {/each}
{/snippet}

<div class="app">
  <header class="toolbar">
    <div class="brand">Magic Mirror</div>
    {#each toolbar as t, i (i)}
      <t.component {app} />
    {/each}
  </header>
  <aside class="col left">{@render columnPanels(left)}</aside>
  <Viewport {app} />
  <aside class="col right">{@render columnPanels(right)}</aside>
  {#if bottom.length}
    <div class="bottom">
      {#each bottom as b, i (i)}<b.component {app} />{/each}
    </div>
  {/if}
  <footer class="status">
    {#each Object.entries($status) as [id, text] (id)}
      {#if text}<span>{text}</span>{/if}
    {/each}
  </footer>
</div>

<style>
  .app {
    display: grid;
    grid-template-columns: 260px 1fr 300px;
    grid-template-rows: 40px 1fr auto 26px;
    grid-template-areas: 'bar bar bar' 'left view right' 'bottom bottom bottom' 'status status status';
    height: 100%;
  }
  .toolbar {
    grid-area: bar;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
  }
  .brand {
    font-weight: 600;
    letter-spacing: 0.02em;
    margin-right: 12px;
  }
  .col {
    overflow-y: auto;
    background: var(--panel);
  }
  .left {
    grid-area: left;
    border-right: 1px solid var(--line);
  }
  .right {
    grid-area: right;
    border-left: 1px solid var(--line);
  }
  .bottom {
    grid-area: bottom;
    background: var(--panel);
    border-top: 1px solid var(--line);
  }
  .bottom:empty {
    display: none;
  }
  .status {
    grid-area: status;
    display: flex;
    gap: 18px;
    align-items: center;
    padding: 0 10px;
    background: var(--panel);
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
  }
</style>
