// Animation timeline: scrub, step and play the scene's keyframes and flipbooks, and export
// every frame as a PNG sequence (straight into a folder in Chrome/Edge).

import type { Feature } from '../core/feature';
import type { App } from '../app';
import { animationLength } from '../vox/scene';

const pad = (n: number) => String(n).padStart(4, '0');

export const timelineFeature: Feature = {
  id: 'timeline',
  init(app) {
    const s = app.settings;
    const bar = app.layout.timeline;
    let length = 0;
    let playing = false;
    let lastAdvance = 0;
    let exporting = false;
    let cancelExport = false;

    const button = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      bar.append(b);
      return b;
    };
    const setFrame = (f: number) => {
      if (length <= 0) return;
      const loop = s.bool('anim.loop');
      if (f > length) f = loop ? 0 : length;
      if (f < 0) f = loop ? length : 0;
      if (f !== s.num('anim.frame')) s.set('anim.frame', f);
    };

    button('⏮', 'First frame', () => setFrame(0));
    button('◀', 'Previous frame (,)', () => setFrame(s.num('anim.frame') - 1));
    const play = button('▶', 'Play / pause (Space)', () => togglePlay());
    button('▶|', 'Next frame (.)', () => setFrame(s.num('anim.frame') + 1));
    button('⏭', 'Last frame', () => setFrame(length));

    const scrub = document.createElement('input');
    scrub.type = 'range';
    scrub.className = 'mm-scrub';
    scrub.min = '0';
    scrub.step = '1';
    scrub.addEventListener('input', () => setFrame(Number(scrub.value)));
    const label = document.createElement('span');
    label.className = 'mm-frame';
    bar.append(scrub, label);

    const numberField = (key: string, text: string, title: string) => {
      const l = document.createElement('label');
      l.title = title;
      const i = document.createElement('input');
      i.type = 'number';
      i.min = '1';
      i.value = String(s.num(key));
      i.addEventListener('change', () => s.set(key, Math.max(1, Number(i.value) || 1)));
      s.onChange((k, v) => { if (k === key) i.value = String(v); });
      l.append(text, i);
      bar.append(l);
    };
    numberField('anim.fps', 'FPS', 'Playback speed (frames per second, at most)');
    numberField('anim.playSamples', 'Preview spp', 'Samples per frame before playback moves on');
    const loopLabel = document.createElement('label');
    const loop = document.createElement('input');
    loop.type = 'checkbox';
    loop.checked = s.bool('anim.loop');
    loop.addEventListener('change', () => s.set('anim.loop', loop.checked));
    loopLabel.append(loop, 'Loop');
    bar.append(loopLabel);
    numberField('anim.exportSamples', 'Export spp', 'Samples per frame when exporting');
    const exportBtn = button('Export frames…', 'Render every frame to PNG (pick a folder in Chrome/Edge). Set Preview scale to 1 for full size.', () => {
      if (exporting) cancelExport = true;
      else exportFrames(app, length).catch((e) => app.layout.setStatus('msg', `Export failed: ${(e as Error).message}`));
    });

    const refresh = () => {
      scrub.max = String(length);
      scrub.value = String(s.num('anim.frame'));
      label.textContent = `${s.num('anim.frame')} / ${length}`;
      play.textContent = playing ? '⏸' : '▶';
      play.classList.toggle('active', playing);
      exportBtn.textContent = exporting ? 'Cancel export' : 'Export frames…';
    };
    const togglePlay = () => {
      if (exporting || length <= 0) return;
      playing = !playing;
      lastAdvance = 0;
      refresh();
    };
    s.onChange((k) => { if (k === 'anim.frame') refresh(); });

    window.addEventListener('keydown', (e) => {
      if (bar.hidden || (e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      if (e.key === ',') setFrame(s.num('anim.frame') - 1);
      if (e.key === '.') setFrame(s.num('anim.frame') + 1);
    });

    app.on('sceneLoaded', (file) => {
      length = animationLength(file);
      playing = false;
      bar.hidden = length <= 0;
      if (s.num('anim.frame') > length) s.set('anim.frame', 0);
      refresh();
    });

    timelineFeature.onFrame = (a) => {
      if (!playing || exporting) return;
      const now = performance.now();
      const ready = a.renderer.samples >= Math.min(s.num('anim.playSamples'), s.num('rt.maxSamples'));
      if (ready && now - lastAdvance >= 1000 / s.num('anim.fps')) {
        lastAdvance = now;
        if (!s.bool('anim.loop') && s.num('anim.frame') >= length) { playing = false; refresh(); return; }
        setFrame(s.num('anim.frame') + 1);
      }
    };

    async function exportFrames(app: App, last: number) {
      if (!app.renderer.ready) return;
      const target = s.num('anim.exportSamples');
      const picker = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
      let dir: FileSystemDirectoryHandle | null = null;
      if (picker) {
        try { dir = await picker({ mode: 'readwrite' }); } catch { return; } // user cancelled
      }
      exporting = true;
      cancelExport = false;
      playing = false;
      refresh();
      const savedMax = s.num('rt.maxSamples');
      s.set('rt.maxSamples', Math.max(savedMax, target));
      const base = app.fileName.replace(/\.vox$/i, '') || 'render';
      try {
        for (let f = 0; f <= last && !cancelExport; f++) {
          s.set('anim.frame', f);
          await waitFor(() => cancelExport || app.renderer.samples >= target);
          if (cancelExport) break;
          const blob = await app.renderPng();
          const name = `${base}_${pad(f)}.png`;
          if (dir) {
            const fh = await dir.getFileHandle(name, { create: true });
            const w = await fh.createWritable();
            await w.write(blob);
            await w.close();
          } else {
            const a = document.createElement('a');
            a.download = name;
            a.href = URL.createObjectURL(blob);
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          }
          app.layout.setStatus('msg', `Exported ${name} (${f + 1}/${last + 1})`);
        }
        if (cancelExport) app.layout.setStatus('msg', 'Export cancelled');
        else app.layout.setStatus('msg', `Exported ${last + 1} frames${dir ? ` to ${dir.name}` : ''}`);
      } finally {
        s.set('rt.maxSamples', savedMax);
        exporting = false;
        refresh();
      }
    }
  },
};

function waitFor(cond: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => (cond() ? resolve() : requestAnimationFrame(tick));
    tick();
  });
}
