<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, collapsed = false, children }: { title: string; collapsed?: boolean; children: Snippet } = $props();
  // The prop only sets where the panel starts; after that it's the user's to open and close.
  let open = $state(true);
  $effect.pre(() => {
    open = !collapsed;
  });
</script>

<section class="panel" class:collapsed={!open}>
  <h2><button type="button" onclick={() => (open = !open)} aria-expanded={open}>{title}</button></h2>
  {#if open}
    <div class="body">{@render children()}</div>
  {/if}
</section>

<style>
  .panel {
    border-bottom: 1px solid var(--line);
  }
  h2 {
    margin: 0;
  }
  h2 button {
    all: unset;
    display: block;
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
  }
  h2 button::before {
    content: '▾ ';
  }
  .collapsed h2 button::before {
    content: '▸ ';
  }
  .body {
    padding: 0 10px 10px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
</style>
