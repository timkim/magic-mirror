// Every feature the app loads, in order. Add new features here.
// Browser-only features (UI tools) live alongside but must keep DOM work inside init().

import type { Feature } from '../core/feature';
import { Settings } from '../core/settings';
import { cameraFeature, lightingFeature, outputFeature } from './core';

/** Features that also run headless (settings and scene handling only). */
export const coreFeatures: Feature[] = [cameraFeature, lightingFeature, outputFeature];

export function createSettings(features: Feature[]): Settings {
  const s = new Settings();
  for (const f of features) for (const g of f.settings ?? []) s.register(g);
  return s;
}
