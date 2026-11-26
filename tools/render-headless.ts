// Render a .vox file to PNG without a browser, using Dawn (the `webgpu` npm package).
// This is also the seed of a network render worker: same renderer, no window.
//
//   npm run render -- scene.vox out.png [--samples 256] [--frame 0] [--hdr sky.hdr] [--set key=value ...]
//   npm run render -- scene.vox frames/city_####.png --frames 0-29   (#### becomes the frame number)
//   e.g. --set cam.yaw=-90 --set out.previewScale=1

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';
import { create, globals } from 'webgpu';
import { parseVox } from '../src/vox/parser';
import { SceneBaker } from '../src/vox/scene';
import { Renderer } from '../src/render/renderer';
import { frameFromSettings, outputSize, postFromSettings } from '../src/render/params';
import { readPixels } from '../src/render/readback';
import { loadHdrEnvironment } from '../src/render/hdr';
import { coreFeatures, createSettings } from '../src/features';
import type { SettingValue } from '../src/core/settings';

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const sets: Record<string, string> = {};
  let samples = 128, frame = 0;
  let hdr: string | undefined;
  let frames: [number, number] | undefined;
  let settingsFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--samples') samples = Number(argv[++i]);
    else if (a === '--frame') frame = Number(argv[++i]);
    else if (a === '--hdr') hdr = argv[++i];
    else if (a === '--settings') settingsFile = argv[++i];
    else if (a === '--frames') { const [x, y] = argv[++i].split('-').map(Number); frames = [x, Number.isFinite(y) ? y : x]; }
    else if (a === '--set') { const [k, ...v] = argv[++i].split('='); sets[k] = v.join('='); }
    else pos.push(a);
  }
  if (pos.length < 2) {
    console.error('usage: render-headless <in.vox> <out.png> [--samples N] [--frame N | --frames A-B] [--hdr sky.hdr] [--settings snapshot.json] [--set key=value]');
    process.exit(1);
  }
  return { input: pos[0], output: pos[1], samples, frame, sets, hdr, frames, settingsFile };
}

/** frames/city_####.png → frames/city_0007.png; without #### the number goes before .png */
function frameName(pattern: string, f: number) {
  const n = String(f).padStart(4, '0');
  return pattern.includes('####') ? pattern.replace('####', n) : pattern.replace(/(\.png)?$/i, `_${n}.png`);
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter available');
  const device = await adapter.requestDevice();

  const file = parseVox(readFileSync(args.input));
  const settings = createSettings(coreFeatures);
  settings.set('anim.frame', args.frame);
  const baker = new SceneBaker(file, args.frames?.[0] ?? args.frame);
  const grid = baker.grid;
  for (const f of coreFeatures) f.onSceneLoaded?.(file, grid, settings);
  // A full settings snapshot (e.g. from the app or a farm job) is applied before any --set.
  if (args.settingsFile) settings.apply(JSON.parse(readFileSync(args.settingsFile, 'utf8')));
  for (const [k, v] of Object.entries(args.sets)) {
    const def = settings.def(k);
    if (!def) { console.warn(`unknown setting ${k}`); continue; }
    let val: SettingValue = v;
    if (def.type === 'number') val = Number(v);
    else if (def.type === 'bool') val = v === 'true' || v === '1';
    else if (def.type === 'color' || def.type === 'vec3') val = v.split(',').map(Number) as [number, number, number];
    settings.set(k, val);
  }

  const errs = await Renderer.shaderErrors(device);
  if (errs.length) throw new Error('Shader errors:\n' + errs.join('\n'));

  const [w, h] = outputSize(settings, [1280, 720]);
  const renderer = new Renderer(device, 'rgba8unorm');
  if (args.hdr) {
    renderer.setEnvironment(loadHdrEnvironment(readFileSync(args.hdr)));
    if (!args.sets['sky.mode']) settings.set('sky.mode', 'hdr');
  }
  renderer.resize(w, h);

  const [first, last] = args.frames ?? [args.frame, args.frame];
  for (let f = first; f <= last; f++) {
    const t0 = performance.now();
    const g = grid;
    if (f === first) renderer.setScene(g, file.palette, file.materials);
    else renderer.updateRegions(baker.setTime(f));
    renderer.setFrame(frameFromSettings(settings, g));
    const batch = 8;
    for (let done = 0; done < args.samples; done += batch) {
      const enc = device.createCommandEncoder();
      renderer.trace(enc, Math.min(batch, args.samples - done));
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
    }
    const px = await readPixels(renderer, postFromSettings(settings));
    const png = new PNG({ width: w, height: h });
    png.data.set(px.data);
    const out = args.frames ? frameName(args.output, f) : args.output;
    mkdirSync(dirname(out) || '.', { recursive: true });
    writeFileSync(out, PNG.sync.write(png));
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`${out}: ${w}×${h}, ${renderer.samples} samples, ${g.voxelCount} voxels, ${secs}s`);
  }
  device.destroy();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
