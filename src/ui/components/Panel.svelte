<script lang="ts">
  // A collapsible side panel (shadcn Collapsible).
  import type { Snippet } from 'svelte';
  import * as Collapsible from '$lib/components/ui/collapsible';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

  let { title, collapsed = false, children }: { title: string; collapsed?: boolean; children: Snippet } = $props();
  // The prop only sets where the panel starts; after that it's the user's to open and close.
  let open = $state(true);
  $effect.pre(() => {
    open = !collapsed;
  });
</script>

<Collapsible.Root bind:open class="border-b border-border">
  <Collapsible.Trigger
    class="flex w-full items-center gap-1.5 px-3 py-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase transition-colors hover:text-foreground"
  >
    <ChevronRightIcon class="size-3.5 transition-transform {open ? 'rotate-90' : ''}" />
    {title}
  </Collapsible.Trigger>
  <Collapsible.Content class="flex flex-col gap-2.5 px-3 pb-3">
    {@render children()}
  </Collapsible.Content>
</Collapsible.Root>
