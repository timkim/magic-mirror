<script lang="ts">
  // Toolbar: edit mode on/off, undo/redo, new scene, save .vox. Also the keyboard shortcuts.
  import type { App } from '../../app';
  import { Button } from '$lib/components/ui/button';
  import { Toggle } from '$lib/components/ui/toggle';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import Undo2Icon from '@lucide/svelte/icons/undo-2';
  import Redo2Icon from '@lucide/svelte/icons/redo-2';
  import FilePlusIcon from '@lucide/svelte/icons/file-plus';
  import SaveIcon from '@lucide/svelte/icons/save';

  let { app }: { app: App } = $props();
  const ed = app.editor;
  const { enabled, mode, brush, mirror, selected } = ed;
  const history = app.history.state;
  const scene = app.scene;

  function undo() {
    const l = app.history.undo();
    if (l) app.setStatus('msg', `Undid: ${l}`);
  }
  function redo() {
    const l = app.history.redo();
    if (l) app.setStatus('msg', `Redid: ${l}`);
  }
  function newScene() {
    if (app.history.state && $history.count && !confirm('Start a new scene? Unsaved edits to this one will be lost.')) return;
    app.newScene();
  }

  function keydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (mod && k === 'y') { e.preventDefault(); return redo(); }
    if (mod && k === 's') { e.preventDefault(); return app.saveVox(); }
    if (mod || e.altKey || !$scene) return;
    if (k === 'tab') { e.preventDefault(); enabled.update((v) => !v); return; }
    if (!$enabled) return;
    const keys: Record<string, () => void> = {
      a: () => mode.set('attach'), e: () => mode.set('erase'), p: () => mode.set('paint'),
      v: () => brush.set('voxel'), b: () => brush.set('box'), f: () => brush.set('face'),
      x: () => mirror.update((m) => ({ ...m, x: !m.x })), y: () => mirror.update((m) => ({ ...m, y: !m.y })), z: () => mirror.update((m) => ({ ...m, z: !m.z })),
      escape: () => { selected.set(null); ed.preview.set({ boxes: [] }); },
    };
    if (keys[k]) { e.preventDefault(); keys[k](); }
  }
</script>

<svelte:window onkeydown={keydown} />

<Toggle size="sm" variant="outline" bind:pressed={$enabled} disabled={!$scene} title="Edit voxels (Tab)" aria-label="Edit voxels"><PencilIcon />Edit</Toggle>
<Button size="icon-sm" variant="ghost" onclick={undo} disabled={!$history.undo} title={$history.undo ? `Undo: ${$history.undo} (Ctrl+Z)` : 'Nothing to undo'} aria-label="Undo"><Undo2Icon /></Button>
<Button size="icon-sm" variant="ghost" onclick={redo} disabled={!$history.redo} title={$history.redo ? `Redo: ${$history.redo} (Ctrl+Shift+Z)` : 'Nothing to redo'} aria-label="Redo"><Redo2Icon /></Button>
<Button size="sm" variant="ghost" onclick={newScene} title="Start an empty scene with one model to build in"><FilePlusIcon />New</Button>
<Button size="sm" variant="outline" onclick={() => app.saveVox()} disabled={!$scene} title="Download the scene with your edits as a .vox MagicaVoxel can open (Ctrl+S)"><SaveIcon />Save .vox</Button>
