# Magic Mirror

A WebGPU viewer and path tracer for MagicaVoxel `.vox` scenes. It runs in the browser with nothing to install.

Goals, in order:
1. **Match MagicaVoxel's look.**
2. **Be easy to extend.** New tools plug in as features without touching the core.
3. Stability, render speed, big scenes, animation and **networked rendering**: any PC on your network can help render an animation.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173 (also reachable from other PCs on your network)
```

Use Chrome or Edge (WebGPU). Open a `.vox` (button or drag-and-drop), or pick one of the test scenes.

- **Orbit:** left-drag. **Pan:** right-drag or Shift-drag. **Zoom:** mouse wheel.
- **File camera** picks any camera slot stored in the .vox (perspective, orthographic or isometric).
- **HDR sky…** (or drop an `.hdr`) lights the scene with an equirectangular HDR image. If the scene was set up with one in MagicaVoxel, the status bar names the file it expects.
- **Timeline** (shown for animated scenes): play, step with `,` and `.`, Space to play or pause. **Export frames…** renders every frame to PNG; in Chrome or Edge it writes straight into a folder you pick.
- **Save PNG** saves the current render at the output resolution (preview scale applied).
- Set **Preview scale** to `1` for final-quality frames. The default output is 1080 × 1920 portrait.

What it renders (fog and media included): sun with soft shadows, uniform / atmosphere / HDR skies, ground plane with horizon fade, diffuse, metal, emissive, glass (refraction, tint, frosted) and blend materials (see-through + glossy coat), depth of field, orthographic cameras, bloom, ACES tone mapping and vignette. Render settings stored in the .vox (sun, sky, atmosphere, HDR, lens, film, bloom, ground, background, bounces, cameras) are read on open.

Other commands:

```bash
npm test                     # parser and scene-graph tests
npm run scenes               # regenerate test-scenes/*.vox
npm run render -- test-scenes/01-diffuse.vox out.png --samples 256 --set out.previewScale=1
npm run render -- city.vox frames/city_####.png --frames 0-29 --hdr sky.hdr --set cam.slot=2
npm run inspect -- city.vox              # print models, materials, render settings, cameras
npm run build                # static build in dist/
```

`npm run render` renders with no browser through Dawn (the `webgpu` npm package). The Node tools are bundled with esbuild and run with plain `node`, because Dawn's GPU threads don't get along with `tsx`.

## Render farm (network rendering)

Spread an animation's frames across every PC on your home network.

1. **On one PC (the coordinator):**
   ```bash
   npm run build      # so the coordinator can serve the app to other PCs
   npm run farm       # prints the address other PCs should use, e.g. http://192.168.1.20:8080
   ```
2. **On each PC that should help render**, either:
   - open that address in Chrome or Edge, expand **Render farm** in the left column and tick **Join as worker** (keep the tab visible), or
   - run a worker with no browser: `npm run worker -- http://192.168.1.20:8080 --name office-pc`
3. **Send a job** from any copy of the app: open the scene, set it up (camera slot, HDR sky, settings), expand **Render farm**, choose frames, samples and scale, and press **Send to farm**.

Workers take one frame at a time, so faster PCs simply do more. A frame that isn't returned within 10 minutes (`--lease 600`) goes to another worker, and a headless worker renders each frame in a fresh process so a GPU crash only costs that frame. Finished frames land in `farm-output/<job>/<name>_0000.png`; when every frame is in, the coordinator makes an `.mp4` if `ffmpeg` is installed, and the panel shows a **video** link. The coordinator has no login, so only run it on a network you trust.

## Matching MagicaVoxel's look

1. Open a scene in MagicaVoxel and in Magic Mirror.
2. Render it in MagicaVoxel at the same resolution and save the image.
3. Click **Reference…** (or drop the image) and compare with **Wipe**, **Overlay** or **Difference**. In Difference mode, black means identical.
4. Adjust the renderer until they match. Places that need checking are marked `TODO(match)` in the code:
   - camera yaw zero direction (`YAW_OFFSET`) and orthographic zoom
   - emission strength (`_emit`, `_flux`, `_ldr`)
   - exposure (`_film._expo`), tone curve, bloom blend (mix vs add)
   - atmosphere model (`_atm`), `_env` mode numbers, sun size (`_area`)
   - glass absorption and media density (`_d`), blend coat strength (`_sp`), fog density (`_fog_uni _d`)
   - ground horizon fade (`_hor`)
   - pivot rule for rotated even-sized models

The **File render settings** panel lists the raw `rOBJ`/`rCAM` dictionaries stored in the open file, so you can see which keys MagicaVoxel wrote.

## How it's built

```
src/
  vox/        parser.ts (reads .vox), scene.ts (scene graph → world voxel grid; SceneBaker
              updates only what moved between animation frames),
              writer.ts (writes test files), renderSettings.ts (file settings → app settings)
  render/     renderer.ts (GPU, no DOM), shaders/ (path tracer, bloom, present pass),
              params.ts (settings → renderer inputs), materials.ts, hdr.ts, readback.ts
  core/       settings.ts (schema-driven settings), feature.ts (the extension interface)
  features/   core.ts (camera, sun, sky, ground & fog, render, image), viewport.ts, compare.ts,
              sceneInfo.ts, environment.ts (HDR sky), timeline.ts, farm.ts (render farm panel)
  farm/       queue.ts (job queue and frame leases)
  ui/         layout.ts (toolbar, docked panels, status bar), settingsPanel.ts (auto-built controls)
tools/        make-test-scenes.ts, render-headless.ts, inspect-vox.ts, coordinator.ts, worker.ts
test-scenes/  one small scene per feature being matched
```

**Rendering:** progressive path tracing, one sample per pixel per pass, accumulated and then tone mapped. Rays skip empty space using an 8×8×8 "brick" occupancy grid, then step voxel by voxel inside occupied bricks. Direct light (sun or HDR sky) is traced through a single shadow-ray call in the shader, which keeps GPU compile times short. The renderer only needs a `GPUDevice`, so the same code runs in the browser and headless.

**Animation:** the voxel grid covers every frame's bounds, and moving to another frame rewrites and re-uploads only the regions where models moved (well under 1% of the grid per frame for a typical city scene).

### Adding a feature

A feature is one object, listed in `src/main.ts`:

```ts
export const myFeature: Feature = {
  id: 'fog',
  settings: [{ id: 'fog', label: 'Fog', defs: [
    { key: 'fog.density', label: 'Density', type: 'number', default: 0, min: 0, max: 1 },
  ]}],
  init(app) { /* optional: add toolbar buttons, panels (app.layout.addPanel), file handlers */ },
  onSceneLoaded(file, grid, settings) { /* optional: read values from the .vox */ },
  onFrame(app, dt) { /* optional: per-frame work, e.g. animation playback */ },
};
```

Declared settings get UI controls automatically, and changing them restarts the progressive render (set `resetsRender: false` for display-only settings).

## Roadmap

- **Look:** calibrate the items listed above against MagicaVoxel renders; fog and subsurface media; edges and grid.
- **Render farm:** job queue page, pause/resume, per-worker GPU info, resuming jobs after a coordinator restart.
- **Big scenes:** sparse bricks instead of the dense grid; streaming.


## Licence

MIT
