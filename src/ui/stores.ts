// Svelte store adapters for the framework-free core.

import type { Writable } from 'svelte/store';
import type { Settings, SettingValue } from '../core/settings';

/** A writable store bound to one setting: `$exposure = 1` sets it, and it updates when anything else does. */
export function settingStore<T extends SettingValue>(settings: Settings, key: string): Writable<T> {
  return {
    subscribe(run) {
      run(settings.get<T>(key));
      const off = settings.onChange((k, v) => {
        if (k === key) run(v as T);
      });
      return () => {
        off();
      };
    },
    set(v) {
      settings.set(key, v);
    },
    update(fn) {
      settings.set(key, fn(settings.get<T>(key)));
    },
  };
}
