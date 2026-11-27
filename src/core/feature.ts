// A Feature is the unit of extension: it can declare settings, add Svelte components to the
// UI, react to scene loads and hook into each frame. New tools (render queue, network status,
// voxel editing...) are written as Features and listed in src/main.ts.
//
// Settings and onSceneLoaded also run headless (Node and render workers), so keep browser-only
// work in init() and in the UI components.

import type { Component } from 'svelte';
import type { Settings, SettingGroup } from './settings';
import type { App } from '../app';
import type { VoxFile } from '../vox/types';
import type { VoxelGrid } from '../vox/scene';

/** Where a UI contribution appears. */
export type UiSlot =
  | 'toolbar' // buttons in the top bar
  | 'left' // a collapsible panel in the left column
  | 'right' // a collapsible panel in the right column
  | 'stage' // an overlay on top of the render (same size as the image)
  | 'bottom'; // a strip under the viewport (e.g. the timeline)

export interface UiContribution {
  slot: UiSlot;
  /** Receives the app as its only prop. */
  component: Component<{ app: App }>;
  /** Panel title (left/right slots). */
  title?: string;
  /** Lower comes first. Settings panels use 0. */
  order?: number;
  collapsed?: boolean;
}

export interface Feature {
  id: string;
  /** Settings this feature owns; controls are built automatically in the side panels. */
  settings?: SettingGroup[];
  /** Svelte components this feature adds to the UI. */
  ui?: UiContribution[];
  /** Browser only: called once after the app exists (before the UI mounts). */
  init?(app: App): void;
  /** Called whenever a .vox file is opened, after its grid is built. Can update settings. */
  onSceneLoaded?(file: VoxFile, grid: VoxelGrid, settings: Settings): void;
  /** Browser only: called every animation frame before rendering. */
  onFrame?(app: App, dt: number): void;
}
