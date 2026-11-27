<script lang="ts">
  // Magic Mirror's shell: toolbar, two side columns of panels, the render view, a bottom strip
  // and the status bar. Features fill it: their settings become panels automatically and their
  // components land in the slot they ask for (see src/core/feature.ts).
  import { ModeWatcher, toggleMode, mode } from 'mode-watcher';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import { Button } from '$lib/components/ui/button';
  import { Separator } from '$lib/components/ui/separator';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import SunIcon from '@lucide/svelte/icons/sun';
  import MoonIcon from '@lucide/svelte/icons/moon';
  import type { App } from '../app';
  import type { SettingGroup } from '../core/settings';
  import type { UiContribution } from '../core/feature';
  import Panel from './components/Panel.svelte';
  import SettingControl from './components/SettingControl.svelte';
  import Viewport from './components/Viewport.svelte';

  let { app }: { app: App } = $props();
  const status = app.status;

  type Item = { order: number; i: number; group?: SettingGroup; ui?: UiContribution };
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

<ModeWatcher defaultMode="dark" />

{#snippet columnPanels(items: Item[])}
  {#each items as item (item.i)}
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

<Tooltip.Provider delayDuration={400}>
  <div
    class="grid h-full grid-cols-[264px_1fr_300px] grid-rows-[44px_1fr_auto_26px] bg-background text-foreground [grid-template-areas:'bar_bar_bar''left_view_right''bottom_bottom_bottom''status_status_status']"
  >
    <header class="flex items-center gap-1.5 border-b border-border bg-card px-3 [grid-area:bar]">
      <div class="mr-2 text-sm font-semibold tracking-tight">Magic Mirror</div>
      <Separator orientation="vertical" class="mx-1 h-5!" />
      {#each toolbar as t, i (i)}
        <t.component {app} />
      {/each}
      <div class="flex-1"></div>
      <Button variant="ghost" size="icon-sm" onclick={toggleMode} aria-label="Switch light or dark theme" title="Switch light or dark theme">
        {#if mode.current === 'dark'}<SunIcon />{:else}<MoonIcon />{/if}
      </Button>
    </header>

    <aside class="min-h-0 border-r border-border bg-card [grid-area:left]">
      <ScrollArea class="h-full">{@render columnPanels(left)}</ScrollArea>
    </aside>

    <Viewport {app} />

    <aside class="min-h-0 border-l border-border bg-card [grid-area:right]">
      <ScrollArea class="h-full">{@render columnPanels(right)}</ScrollArea>
    </aside>

    {#if bottom.length}
      <div class="bg-card [grid-area:bottom]">
        {#each bottom as b, i (i)}<b.component {app} />{/each}
      </div>
    {/if}

    <footer class="flex items-center gap-5 overflow-hidden border-t border-border bg-card px-3 text-xs whitespace-nowrap text-muted-foreground [grid-area:status]">
      {#each Object.entries($status) as [id, text] (id)}
        {#if text}<span>{text}</span>{/if}
      {/each}
    </footer>
  </div>
</Tooltip.Provider>
