// A Feature is the unit of extension: it can declare settings, add panels to the UI,
// react to scene loads and hook into each frame. New tools (animation timeline,
// render queue, network status...) are written as Features and listed in features/index.ts.
//
// Keep DOM work inside init() so the same feature list also works in headless renders.

import type { Settings, SettingGroup } from './settings';
import type { App } from '../app';
import type { VoxFile } from '../vox/types';
import type { VoxelGrid } from '../vox/scene';

export interface Feature {
  id: string;
  /** Settings this feature owns; rendered automatically in the settings panel. */
  settings?: SettingGroup[];
  /** Browser only: called once after the app (renderer, UI, settings) exists. */
  init?(app: App): void;
  /** Called whenever a .vox file is opened, after its grid is built. Can update settings. */
  onSceneLoaded?(file: VoxFile, grid: VoxelGrid, settings: Settings): void;
  /** Browser only: called every animation frame before rendering. */
  onFrame?(app: App, dt: number): void;
}
