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
    // Clipboard and duplicate/delete act on the selected object or group.
    const sel = $selected;
    try {
      if (mod && k === 'c' && sel !== null) { e.preventDefault(); return void ed.copy(sel); }
      if (mod && k === 'v' && $scene) { e.preventDefault(); const t = app.settings.vec('cam.target'); return void ed.paste([t[0], t[1]]); }
      if (mod && k === 'd' && sel !== null) { e.preventDefault(); return void ed.duplicate(sel); }
      if ((k === 'delete' || k === 'backspace') && !mod && sel !== null && $enabled) { e.preventDefault(); return ed.deleteObject(sel); }
    } catch (err) {
      app.setStatus('msg', (err as Error).message);
      return;
    }
    if (mod || e.altKey || !$scene) return;
    if (k === 'tab') { e.preventDefault(); enabled.update((v) => !v); return; }
    if (!$enabled) return;
    const keys: Record<string, () => void> = {
      a: () => mode.set('attach'), e: () => mode.set('erase'), p: () => mode.set('paint'), m: () => mode.set('move'),
      v: () => brush.set('voxel'), b: () => brush.set('box'), f: () => brush.set('face'), l: () => brush.set('line'), s: () => brush.set('sphere'),
      r: () => { const id = $selected; if (id !== null) ed.rotateObject(id, e.shiftKey ? 1 : -1); },
      x: () => mirror.update((m) => ({ ...m, x: !m.x })), y: () => mirror.update((m) => ({ ...m, y: !m.y })), z: () => mirror.update((m) => ({ ...m, z: !m.z })),
      escape: () => { selected.set(null); ed.preview.set({ boxes: [] }); },
    };
    if (keys[k]) { e.preventDefault(); keys[k](); return; }
    // Arrow keys nudge the selected object in Move mode (PageUp/PageDown: up and down).
    const nudge: Record<string, [number, number, number]> = { arrowleft: [-1, 0, 0], arrowright: [1, 0, 0], arrowup: [0, 1, 0], arrowdown: [0, -1, 0], pageup: [0, 0, 1], pagedown: [0, 0, -1] };
    if ($mode === 'move' && $selected !== null && nudge[k]) {
      e.preventDefault();
      ed.moveObject($selected, nudge[k].map((v) => v * (e.shiftKey ? 10 : 1)) as [number, number, number], 'Nudge object');
    }
  }
</script>

<svelte:window onkeydown={keydown} />

<Toggle size="sm" variant="outline" bind:pressed={$enabled} disabled={!$scene} title="Edit voxels (Tab)" aria-label="Edit voxels"><PencilIcon />Edit</Toggle>
<Button size="icon-sm" variant="ghost" onclick={undo} disabled={!$history.undo} title={$history.undo ? `Undo: ${$history.undo} (Ctrl+Z)` : 'Nothing to undo'} aria-label="Undo"><Undo2Icon /></Button>
<Button size="icon-sm" variant="ghost" onclick={redo} disabled={!$history.redo} title={$history.redo ? `Redo: ${$history.redo} (Ctrl+Shift+Z)` : 'Nothing to redo'} aria-label="Redo"><Redo2Icon /></Button>
<Button size="sm" variant="ghost" onclick={newScene} title="Start an empty scene with one model to build in"><FilePlusIcon />New</Button>
<Button size="sm" variant="outline" onclick={() => app.saveVox()} disabled={!$scene} title="Download the scene with your edits as a .vox MagicaVoxel can open (Ctrl+S)"><SaveIcon />Save .vox</Button>
