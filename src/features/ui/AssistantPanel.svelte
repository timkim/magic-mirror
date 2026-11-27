<script lang="ts">
  // Chat with Claude about the open scene. Claude Code runs on this PC (through the bridge in
  // `npm run farm`) and changes the scene with the same undoable commands as the editor.
  import { tick } from 'svelte';
  import type { App } from '../../app';
  import { Button } from '$lib/components/ui/button';
  import SendIcon from '@lucide/svelte/icons/send-horizontal';
  import SquareIcon from '@lucide/svelte/icons/square';
  import Undo2Icon from '@lucide/svelte/icons/undo-2';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import WrenchIcon from '@lucide/svelte/icons/wrench';
  import { bridge, busy, cloud, cloudUrl, connectCloud, disconnectCloud, messages, newChat, send, stop, undoReply, type Message } from '../../assistant/client';
  import SmartphoneIcon from '@lucide/svelte/icons/smartphone';
  import { farmUrl } from '../farmClient';

  let { app }: { app: App } = $props();
  const history = app.history.state;
  let input = $state('');
  let list: HTMLElement;
  let showConnect = $state(false);
  let showPhone = $state(false);
  // Opened from the Worker itself (the hosted site): that's the connector's address.
  let phoneUrl = $state($cloudUrl || (location.protocol === 'https:' && !/^(localhost|127\.)/.test(location.hostname) ? location.origin : ''));
  let phoneKey = $state('');
  let mcpUrl = $derived(new URL('/mcp', $farmUrl).toString());
  // The client updates messages in place, so give the view fresh objects on every change.
  let view = $derived($messages.map((m) => ({ ...m, src: m, parts: m.parts.map((p) => ({ ...p })) })));

  $effect(() => {
    void $messages;
    tick().then(() => list && (list.scrollTop = list.scrollHeight));
  });

  function submit() {
    const t = input.trim();
    if (!t) return;
    input = '';
    void send(app, t);
  }
  const canUndo = (m: Message) => m.undoFrom !== undefined && m.undoTo !== undefined && m.undoTo > m.undoFrom && $history.count === m.undoTo;
</script>

<div class="grid gap-2 text-xs">
  <div class="flex items-center gap-1.5 text-muted-foreground">
    <span class="size-2 rounded-full {$bridge.state === 'ready' ? 'bg-emerald-500' : $bridge.state === 'connecting' ? 'bg-amber-500' : 'bg-red-500'}"></span>
    <span class="flex-1 truncate">
      {#if $bridge.state === 'ready'}Claude Code on this PC{:else if $bridge.state === 'no-claude'}Claude Code isn't installed{:else if $bridge.state === 'connecting'}Connecting…{:else}Not connected{/if}
    </span>
    <Button size="icon-xs" variant="ghost" class={$cloud.state === 'ready' ? 'text-emerald-500' : $cloud.state === 'error' ? 'text-red-500' : ''} title={$cloud.state === 'ready' ? 'Phone access is on' : 'Phone access: let claude.ai on any device use this tab'} aria-label="Phone access" onclick={() => (showPhone = !showPhone)}><SmartphoneIcon /></Button>
    <Button size="icon-xs" variant="ghost" title="Use these tools from Claude desktop or Claude Code" aria-label="Connect other Claude apps" onclick={() => (showConnect = !showConnect)}><WrenchIcon /></Button>
    <Button size="icon-xs" variant="ghost" title="New chat" aria-label="New chat" onclick={newChat} disabled={$busy}><PlusIcon /></Button>
  </div>

  {#if showConnect || $bridge.state === 'offline' || $bridge.state === 'no-claude'}
    <div class="grid gap-1 rounded-md border border-border p-2 leading-relaxed text-muted-foreground">
      {#if $bridge.state === 'offline'}
        <p class="m-0">Run <code class="text-foreground">npm run farm</code> on this PC, then open Magic Mirror from it.</p>
      {:else if $bridge.state === 'no-claude'}
        <p class="m-0">Install Claude Code on this PC and run <code class="text-foreground">claude</code> once to sign in. Then restart <code class="text-foreground">npm run farm</code>.</p>
      {/if}
      <p class="m-0">To drive this tab from Claude Code or the desktop app, add this MCP server:</p>
      <code class="block rounded bg-muted p-1.5 break-all text-foreground select-all">claude mcp add --transport http magic-mirror {mcpUrl}</code>
    </div>
  {/if}

  {#if showPhone}
    <div class="grid gap-1.5 rounded-md border border-border p-2 leading-relaxed text-muted-foreground">
      <p class="m-0 font-medium text-foreground">Phone access</p>
      {#if $cloud.state === 'ready'}
        <p class="m-0">This tab is connected to your Magic Mirror connector. In claude.ai, add a custom connector with this address:</p>
        <code class="block rounded bg-muted p-1.5 break-all text-foreground select-all">{$cloudUrl}/mcp</code>
        <Button size="xs" variant="outline" class="justify-self-start" onclick={disconnectCloud}>Disconnect this tab</Button>
      {:else}
        <p class="m-0">Lets claude.ai on any device use this tab, through your own Cloudflare Worker (see <code class="text-foreground">cloud/README.md</code>).</p>
        <input bind:value={phoneUrl} placeholder="https://magic-mirror.you.workers.dev" class="h-7 rounded-md border border-input bg-transparent px-2 text-xs text-foreground" aria-label="Connector address" />
        <input bind:value={phoneKey} type="password" placeholder="Your Magic Mirror key" class="h-7 rounded-md border border-input bg-transparent px-2 text-xs text-foreground" aria-label="Magic Mirror key" />
        <Button size="xs" class="justify-self-start" disabled={!phoneUrl.trim() || !phoneKey.trim()} onclick={() => { connectCloud(app, phoneUrl, phoneKey); phoneKey = ''; }}>Connect</Button>
        {#if $cloud.state === 'connecting'}<p class="m-0">Connecting…</p>{/if}
        {#if $cloud.state === 'error'}<p class="m-0 text-red-400">{$cloud.message ?? "Couldn't connect."}</p>{/if}
      {/if}
    </div>
  {/if}

  <div bind:this={list} class="grid max-h-[min(55vh,480px)] min-h-24 content-start gap-2 overflow-y-auto rounded-md border border-border p-2">
    {#if view.length === 0}
      <p class="m-0 text-muted-foreground">Ask Claude to change the scene, e.g. “add a lighthouse on the hill”, “make the windows glow”, or “slow orbit, golden hour, 60 frames”.</p>
    {/if}
    {#each view as m, i (i)}
      {#if m.role === 'user'}
        <div class="justify-self-end rounded-lg bg-primary px-2.5 py-1.5 whitespace-pre-wrap text-primary-foreground">{(m.parts[0] as { text: string }).text}</div>
      {:else}
        <div class="grid gap-1.5">
          {#if m.external}<span class="text-[11px] text-muted-foreground">From another Claude app</span>{/if}
          {#each m.parts as p, j (j)}
            {#if p.kind === 'text'}
              <div class="leading-relaxed whitespace-pre-wrap">{p.text}</div>
            {:else}
              <div class="flex min-w-0 items-center gap-1.5 text-muted-foreground" title={p.summary}>
                <span class="size-1.5 shrink-0 rounded-full {p.status === 'running' ? 'animate-pulse bg-amber-500' : p.status === 'error' ? 'bg-red-500' : 'bg-emerald-500'}"></span>
                <span class="shrink-0 text-foreground">{p.name}</span>
                <span class="truncate">{p.summary}</span>
              </div>
              {#if p.image}<img src={p.image} alt="Preview render" class="max-h-48 w-auto justify-self-start rounded border border-border" />{/if}
            {/if}
          {/each}
          {#if m.error}<div class="text-red-400">{m.error}</div>{/if}
          {#if $busy && i === view.length - 1 && !m.external}<div class="animate-pulse text-muted-foreground">Working…</div>{/if}
          {#if canUndo(m)}
            <Button size="xs" variant="ghost" class="justify-self-start" onclick={() => undoReply(app, m.src)}><Undo2Icon />Undo this reply</Button>
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  <div class="flex items-end gap-1.5">
    <textarea
      bind:value={input}
      rows="2"
      placeholder="Ask Claude…"
      class="min-h-9 flex-1 resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onkeydown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      }}
      disabled={$bridge.state !== 'ready'}
    ></textarea>
    {#if $busy}
      <Button size="icon-sm" variant="outline" onclick={stop} title="Stop" aria-label="Stop"><SquareIcon /></Button>
    {:else}
      <Button size="icon-sm" onclick={submit} disabled={!input.trim() || $bridge.state !== 'ready'} title="Send (Enter)" aria-label="Send"><SendIcon /></Button>
    {/if}
  </div>
</div>
