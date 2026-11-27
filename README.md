# Magic Mirror

**Magic Mirror** is the web interface: a browser viewer and editor for MagicaVoxel `.vox` scenes, with nothing to install.
**Magic Prism** is the render technology underneath it: the WebGPU path tracer, the render farm (coordinator and workers) and the native `prism` worker.

Goals, in order:
1. **Match MagicaVoxel's look.**
2. **Be easy to extend.** New tools plug in as features without touching the core.
3. Stability, render speed, big scenes, animation and **networked rendering**: any PC on your network can help render an animation.

## Front end

Magic Mirror is built with **Svelte 5 + Vite**, styled with **Tailwind CSS 4** and **[shadcn-svelte](https://www.shadcn-svelte.com)** components (the `nova` preset), and starts in **dark mode** (the sun/moon button in the toolbar switches; the choice is remembered).

- `src/ui/`: the app shell (`App.svelte`), the render viewport, collapsible panels and the auto-built setting controls.
- `src/features/ui/`: each feature's components (toolbar buttons, scene panels, timeline, Magic Prism farm panel).
- `src/lib/components/ui/`: shadcn-svelte components, owned by this repo. Add more with `npx shadcn-svelte@latest add <name>`.

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

## Editing voxels

Magic Mirror has a voxel editor modelled on MagicaVoxel's model mode. Turn on **Edit** in the toolbar (or press Tab), click a model to edit it, then:

| Do this | How |
|---|---|
| Add, remove or recolour voxels | **Attach** (A), **Erase** (E), **Paint** (P) |
| Brush | **Voxel** (V, drag to draw on the plane you started on), **Box** (B, drag a rectangle), **Face** (F, the whole same-coloured face) |
| Mirror | X, Y, Z buttons or keys, across the model's centre |
| Edit another model | Ctrl+click it; Esc to stop editing |
| Pick a colour from the scene | Alt+click |
| Orbit / pan while editing | right-drag / middle-drag (or Shift+right-drag) |
| Undo / redo | Ctrl+Z / Ctrl+Shift+Z |
| Save | **Save .vox** (Ctrl+S): the file still opens in MagicaVoxel |

The **Palette** panel edits colours and materials (diffuse, metal, glass, emit, blend, media). **New** starts an empty scene, and **Add** in the Edit panel puts a new empty model at the camera target. Saving keeps everything Magic Mirror doesn't edit: an untouched file comes back byte for byte, and edited files are sent to the render farm automatically.

Every change goes through one undo history, and the same calls the tools use are there for scripts (and the coming assistant): `app.editor.setVoxels(modelId, [[x, y, z, colour], …])`, `setColor`, `setMaterial` and `addModel`.

## Magic Prism render farm (network rendering)

Spread an animation's frames across every PC on your home network.

1. **On one PC (the coordinator):**
   ```bash
   npm run build      # so the coordinator can serve the app to other PCs
   npm run farm       # prints the address other PCs should use, e.g. http://192.168.1.20:8080
   ```
2. **On each PC that should help render**, either:
   - open that address in Chrome or Edge, expand **Magic Prism farm** in the left column and tick **Join as worker** (keep the tab visible), or
   - run a worker with no browser: `npm run worker -- http://192.168.1.20:8080 --name office-pc`
   - or run the native worker: `prism http://192.168.1.20:8080` (see below)
3. **Send a job** from any copy of the app: open the scene, set it up (camera slot, HDR sky, settings), expand **Magic Prism farm**, choose frames, samples and scale, and press **Send to farm**.

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

## Native Magic Prism worker (Rust)

`rust/` is `prism`, the native renderer and farm worker, built on [wgpu](https://wgpu.rs) (Vulkan, DirectX 12 or Metal). It runs the **same WGSL shaders** as the app (extracted from `src/render/shaders` at build time), so its frames match the browser and Node renderers pixel for pixel. Compared with the Node worker it keeps the GPU and the scene loaded between frames instead of reloading for every frame, needs no Node install, and is one file you can copy to each PC.

```bash
cd rust
cargo build --release          # → rust/target/release/prism (prism.exe on Windows)

# join a render farm
./target/release/prism http://192.168.1.20:8080 --name office-pc

# render locally with the app's settings (Magic Prism farm panel → Save settings)
./target/release/prism render city.vox out/city_####.png --settings city-settings.json --frames 0-29 --samples 256
```

`render` takes the same options as `npm run render`: `--frame N` or `--frames A-B`, `--samples N`, `--hdr sky.hdr` and `--set key=value`. Build it on each platform you want to run it on (or cross-compile); the shaders are embedded, so the binary needs nothing else.

## How it's built

```
src/
  vox/        parser.ts (reads .vox), scene.ts (scene graph → world voxel grid; SceneBaker
              updates only what moved between animation frames),
              serialize.ts (writes a scene back to .vox), writer.ts (test files), empty.ts
              (new scenes), renderSettings.ts (file settings → app settings)
  edit/       editor.ts (voxel tools and the scripting API), history.ts (undo/redo),
              volume.ts (dense model editing), pick.ts (camera rays, projection, picking)
  render/     renderer.ts (GPU, no DOM), shaders/ (path tracer, bloom, present pass),
              params.ts (settings → renderer inputs), materials.ts, hdr.ts, readback.ts
  core/       settings.ts (schema-driven settings), feature.ts (the extension interface)
  features/   core.ts (camera, sun, sky, ground & fog, render, image), viewport.ts, compare.ts,
              sceneInfo.ts, environment.ts (HDR sky), timeline.ts, farm.ts (render farm panel),
              editor.ts (edit toolbar, panels and outlines)
  farm/       queue.ts (job queue and frame leases)
  ui/         App.svelte (shell), components/ (Viewport, Panel, SettingControl), stores.ts
  lib/        shadcn-svelte components and utils
tools/        make-test-scenes.ts, render-headless.ts, inspect-vox.ts, coordinator.ts, worker.ts
rust/         native wgpu renderer and farm worker (vox, scene, materials, hdr, settings, renderer, farm)
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
  ui: [{ slot: 'left', title: 'Fog tools', component: FogPanel }], // optional Svelte components
  init(app) { /* optional: file handlers, event listeners */ },
  onSceneLoaded(file, grid, settings) { /* optional: read values from the .vox */ },
  onFrame(app, dt) { /* optional: per-frame work, e.g. animation playback */ },
};
```

Declared settings get UI controls automatically, and changing them restarts the progressive render (set `resetsRender: false` for display-only settings). A feature adds UI by listing Svelte components in `ui`, each with a slot: `toolbar`, `left` or `right` (a collapsible panel), `stage` (an overlay on the render) or `bottom` (a strip under the viewport, like the timeline). Components get the `app` prop; `settingStore(app.settings, key)` gives a two-way Svelte store for any setting.

## Roadmap

- **Assistant:** a chat panel where Claude changes the scene through the editor's commands (camera moves and keyframes, materials, building models), connected through MCP so it runs on your own Claude plan.
- **Editor:** resize, move and rotate models; layers; line and sphere brushes; camera keyframes on the timeline.
- **Look:** calibrate the items listed above against MagicaVoxel renders; fog and subsurface media; edges and grid.
- **Magic Prism farm:** job queue page, pause/resume, per-worker GPU info, resuming jobs after a coordinator restart.
- **Big scenes:** sparse bricks instead of the dense grid; streaming.


## Licence

MIT
