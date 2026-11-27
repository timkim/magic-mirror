// The tools Claude can use on the open Magic Mirror scene. Shared by the bridge (which lists
// them over MCP, even before a browser tab connects) and the tab (which runs them, see tools.ts).
// No DOM or app imports here, so the Node bridge can bundle this file.

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const vec3 = (description: string) => ({ type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description });
const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'integer', description, ...extra });

/** Read once by Claude at the start of a conversation (MCP `instructions` and the chat prompt). */
export const ASSISTANT_GUIDE = `You are working inside Magic Mirror, a MagicaVoxel-compatible voxel editor and path-traced renderer. The user sees the scene update live in their browser.

- Coordinates are integers and Z is up. A scene has models (voxel volumes, each up to 256 per axis) placed by objects (transforms). Several objects can share one model.
- Voxel edits use the model's own coordinates: 0..size-1 on each axis. Colours are palette indices 1-255; colour 0 erases.
- Start with get_scene (objects list their group; groups list their members). For cities, check list_assets first: placing library pieces (roads, buildings, trees, cars) is faster and more consistent than drawing them. Use duplicate_object to repeat things (rows of houses, trees) instead of drawing them again. Use set_object to move, turn, hide or re-layer objects and resize_model to give a model more room. Use draw_shapes for anything bigger than a few voxels. Use set_voxels for detail.
- To build something new, add_model with a size that fits it, then draw into it. Put its bottom on the ground: position z = size z / 2 plus the ground height that get_scene reports.
- Pick colours from the palette that get_scene describes, or set new ones in unused slots with set_palette (never recolour a slot the scene already uses unless asked).
- Animation: objects move between keyframes with set_object_animation (MagicaVoxel interpolates position linearly). The camera animates with set_camera_keyframes (orbits, push-ins, crane moves); get_scene shows the keys and the timeline end. The sun, sky and render settings are settings (list_settings, set_settings); set_frame shows a frame. To check a camera move, preview a few frames (set_frame, then render_preview).
- After visible changes, call render_preview and look at the result before saying you're done. Keep previews small and samples low unless asked.
- Everything you do is one undoable step per tool call. Keep replies short: say what you changed.`;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'get_scene',
    description: 'Summary of the open scene: objects (id, name, model, size, position, keyframes), bounds, ground height, animation length, palette colours in use, unused palette slots, camera and current frame.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_model',
    description: "A model's size and voxels as [x, y, z, colour] in its own coordinates (capped at max_voxels).",
    inputSchema: { type: 'object', properties: { model_id: int('Model id from get_scene'), max_voxels: int('Default 5000', { maximum: 50000 }) }, required: ['model_id'] },
  },
  {
    name: 'set_voxels',
    description: 'Set individual voxels of a model: each entry is [x, y, z, colour] in model coordinates; colour 0 erases.',
    inputSchema: {
      type: 'object',
      properties: {
        model_id: int('Model id'),
        voxels: { type: 'array', items: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 } },
        label: { type: 'string', description: 'Short description for the undo history' },
      },
      required: ['model_id', 'voxels'],
    },
  },
  {
    name: 'draw_shapes',
    description:
      'Draw shapes into a model (model coordinates, inclusive). Shapes: box {from, to}; sphere {center, radius}; cylinder {center (bottom centre), radius, height} standing on Z; line {from, to, radius?}. ' +
      "mode: 'set' overwrites (default), 'add' only fills empty cells, 'paint' only recolours filled cells, 'erase' removes. hollow: true keeps only the outer shell (box, sphere, cylinder).",
    inputSchema: {
      type: 'object',
      properties: {
        model_id: int('Model id'),
        shapes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              shape: { type: 'string', enum: ['box', 'sphere', 'cylinder', 'line'] },
              from: vec3('box/line start'),
              to: vec3('box/line end'),
              center: vec3('sphere centre, or cylinder bottom centre'),
              radius: { type: 'number' },
              height: { type: 'integer' },
              color: int('Palette index 1-255 (ignored for erase)'),
              mode: { type: 'string', enum: ['set', 'add', 'paint', 'erase'] },
              hollow: { type: 'boolean' },
            },
            required: ['shape'],
          },
        },
        label: { type: 'string' },
      },
      required: ['model_id', 'shapes'],
    },
  },
  {
    name: 'add_model',
    description: 'Add an empty model and an object placing it. position is the world position of the model centre. Returns model_id and object_id.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, size: vec3('Size in voxels (1-256 each)'), position: vec3('World position of the centre') },
      required: ['name', 'size', 'position'],
    },
  },
  {
    name: 'move_object',
    description: 'Place an object at a position (relative to its parent; usually world). Removes its animation keyframes. rotation_z: 0, 90, 180 or 270 degrees.',
    inputSchema: { type: 'object', properties: { object_id: int('Object id from get_scene'), position: vec3('Position'), rotation_z: { type: 'number' } }, required: ['object_id', 'position'] },
  },
  {
    name: 'set_object',
    description: 'Change an object or a whole group: move_by [dx,dy,dz] (keeps its keyframes, shifting them all), rotate (quarter turns about Z, positive = counter-clockwise from above, in place), name, hidden, layer (0-15).',
    inputSchema: {
      type: 'object',
      properties: { object_id: int('Object id'), move_by: vec3('Voxels to move by'), rotate: { type: 'integer' }, name: { type: 'string' }, hidden: { type: 'boolean' }, layer: { type: 'integer' } },
      required: ['object_id'],
    },
  },
  {
    name: 'list_assets',
    description: 'The asset library: reusable SimCity-style pieces on a 16-voxel tile grid (terrain and road tiles 16×16, buildings on 16/32 lots, props such as trees, cars, street lights) plus the user\'s own saved assets. Optional category or search text.',
    inputSchema: { type: 'object', properties: { category: { type: 'string' }, search: { type: 'string' } } },
  },
  {
    name: 'place_asset',
    description: 'Put a library asset in the scene, centred at position [x, y] with its base on the ground, or at [x, y, z] with its base at height z (e.g. on a rooftop). rotate: quarter turns about Z. Its colours are added to free palette slots if they differ. Returns the new object_id.',
    inputSchema: { type: 'object', properties: { asset_id: { type: 'string' }, position: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 3 }, rotate: { type: 'integer' } }, required: ['asset_id', 'position'] },
  },
  {
    name: 'save_asset',
    description: "Save an object or group from the scene into the user's library (My assets) so it can be placed again, in this or other scenes.",
    inputSchema: { type: 'object', properties: { object_id: int('Object or group id'), name: { type: 'string' }, category: { type: 'string' } }, required: ['object_id', 'name'] },
  },
  {
    name: 'duplicate_object',
    description: 'Copy an object or group (with its own copy of the voxels). offset [dx,dy,dz] places the copy; default is just beside the original. Returns the new object_id.',
    inputSchema: { type: 'object', properties: { object_id: int('Object or group id'), offset: vec3('Where the copy goes, relative to the original') }, required: ['object_id'] },
  },
  {
    name: 'delete_object',
    description: 'Remove an object or group from the scene.',
    inputSchema: { type: 'object', properties: { object_id: int('Object or group id') }, required: ['object_id'] },
  },
  {
    name: 'resize_model',
    description: "Change a model's box size (1-256 per axis). offset shifts the existing voxels inside the new box, e.g. size +4 in Z with offset [0,0,4] adds room underneath. Voxels outside the new box are cut. Objects using the model stay where they are.",
    inputSchema: { type: 'object', properties: { model_id: int('Model id'), size: vec3('New size'), offset: vec3('Shift of existing voxels (default 0,0,0)') }, required: ['model_id', 'size'] },
  },
  {
    name: 'set_layer',
    description: 'Rename a layer (0-15) or show/hide it with everything on it.',
    inputSchema: { type: 'object', properties: { layer_id: { type: 'integer' }, name: { type: 'string' }, hidden: { type: 'boolean' } }, required: ['layer_id'] },
  },
  {
    name: 'set_object_animation',
    description: 'Give an object position keyframes (MagicaVoxel interpolates linearly between them). Use extra keys to ease. rotation_z per key: 0/90/180/270.',
    inputSchema: {
      type: 'object',
      properties: {
        object_id: int('Object id'),
        keyframes: {
          type: 'array',
          items: { type: 'object', properties: { frame: { type: 'integer' }, position: vec3('Position'), rotation_z: { type: 'number' } }, required: ['frame', 'position'] },
        },
      },
      required: ['object_id', 'keyframes'],
    },
  },
  {
    name: 'set_palette',
    description: 'Set palette colours: [{index (1-255), hex "#rrggbb"}].',
    inputSchema: {
      type: 'object',
      properties: { colors: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, hex: { type: 'string' } }, required: ['index', 'hex'] } } },
      required: ['colors'],
    },
  },
  {
    name: 'set_material',
    description:
      "Set a palette index's material. type: diffuse, metal, glass, emit, blend, media. properties (0-1 unless noted): metal: metal, rough; glass: trans, rough, ri (refractive index 1-3), d (absorption); emit: emit, flux (0-4); blend: trans, rough, metal; media: d (density).",
    inputSchema: {
      type: 'object',
      properties: { index: int('Palette index 1-255'), type: { type: 'string', enum: ['diffuse', 'metal', 'glass', 'emit', 'blend', 'media'] }, properties: { type: 'object', additionalProperties: { type: 'number' } } },
      required: ['index', 'type'],
    },
  },
  {
    name: 'list_settings',
    description: 'Every render setting (camera, sun, sky, fog, ground, output, image, animation) with its key, current value and range. Optional group filter, e.g. "cam".',
    inputSchema: { type: 'object', properties: { group: { type: 'string' } } },
  },
  {
    name: 'set_settings',
    description: 'Change settings by key, e.g. {"cam.yaw": 30, "sun.pitch": 15, "sky.mode": "atmosphere"}. Colours are [r, g, b] in 0-1. One undo step.',
    inputSchema: { type: 'object', properties: { values: { type: 'object' } }, required: ['values'] },
  },
  {
    name: 'set_camera_keyframes',
    description:
      'Animate the camera. Each key: frame plus any of target [x,y,z] (orbit centre), yaw, pitch, distance, fov, ortho_size, ease ("smooth" default, or "linear" from this key to the next). ' +
      'Missing values carry over from the previous key (or the current camera). Yaw is in degrees and not wrapped: yaw 0 at frame 0 to 360 at frame 119 with ease linear is one full orbit. ' +
      'Replaces all camera keys unless replace is false; an empty list removes them. end_frame sets the last frame of the timeline.',
    inputSchema: {
      type: 'object',
      properties: {
        keyframes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              frame: { type: 'integer' }, target: vec3('Point the camera orbits and looks at'), yaw: { type: 'number' }, pitch: { type: 'number' },
              distance: { type: 'number' }, fov: { type: 'number' }, ortho_size: { type: 'number' }, ease: { type: 'string', enum: ['smooth', 'linear'] },
            },
            required: ['frame'],
          },
        },
        replace: { type: 'boolean' },
        end_frame: { type: 'integer' },
      },
      required: ['keyframes'],
    },
  },
  {
    name: 'set_frame',
    description: 'Show an animation frame.',
    inputSchema: { type: 'object', properties: { frame: { type: 'integer' } }, required: ['frame'] },
  },
  {
    name: 'render_preview',
    description: 'Render the current view and return it as an image so you can check your work. samples default 32, max_size default 640 px.',
    inputSchema: { type: 'object', properties: { samples: { type: 'integer', maximum: 1024 }, max_size: { type: 'integer', maximum: 1600 } } },
  },
  {
    name: 'undo',
    description: 'Undo the last steps (default 1). Returns what was undone.',
    inputSchema: { type: 'object', properties: { steps: { type: 'integer' } } },
  },
  {
    name: 'save_vox',
    description: 'Download the scene as a .vox file in the browser (the user picks where it goes).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'farm_status',
    description: 'Progress of Magic Prism render farm jobs (frames done, frames rendering, average seconds per frame, video ready) and which worker PCs are online.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'render_on_farm',
    description: 'Send frames to the Magic Prism render farm. Defaults: the whole animation, 256 samples, full output size.',
    inputSchema: { type: 'object', properties: { first_frame: { type: 'integer' }, last_frame: { type: 'integer' }, samples: { type: 'integer' }, scale: { type: 'number' } } },
  },
];
