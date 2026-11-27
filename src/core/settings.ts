// Schema-driven settings. Each feature declares its settings once; the UI builds its
// controls from these definitions and the renderer reads values by key. Adding a feature
// never needs hand-written UI wiring.

export type SettingValue = number | boolean | string | [number, number, number];

interface BaseDef<T extends SettingValue> {
  key: string;
  label: string;
  default: T;
  /** Short help shown as a tooltip. */
  help?: string;
  /** Changing this setting restarts progressive accumulation (default true). */
  resetsRender?: boolean;
}

export interface NumberDef extends BaseDef<number> { type: 'number'; min: number; max: number; step?: number }
export interface BoolDef extends BaseDef<boolean> { type: 'bool' }
export interface ColorDef extends BaseDef<[number, number, number]> { type: 'color' } // 0-1 linear-ish RGB as stored in .vox
export interface SelectDef extends BaseDef<string> { type: 'select'; options: { value: string; label: string }[] }
export interface Vec3Def extends BaseDef<[number, number, number]> { type: 'vec3'; step?: number }

/** Free text (e.g. JSON); no automatic control, so put these in a hidden group. */
export interface TextDef extends BaseDef<string> { type: 'text' }

export type SettingDef = NumberDef | BoolDef | ColorDef | SelectDef | Vec3Def | TextDef;

export interface SettingGroup {
  id: string;
  label: string;
  defs: SettingDef[];
  /** Panel slot the group's controls go into. */
  slot?: 'left' | 'right';
  /** Don't build controls for this group (a feature provides its own UI). */
  hidden?: boolean;
}

type Listener = (key: string, value: SettingValue) => void;

export class Settings {
  readonly groups: SettingGroup[] = [];
  private defs = new Map<string, SettingDef>();
  private values = new Map<string, SettingValue>();
  private listeners = new Set<Listener>();

  register(group: SettingGroup) {
    for (const d of group.defs) {
      if (this.defs.has(d.key)) throw new Error(`Duplicate setting key ${d.key}`);
      this.defs.set(d.key, d);
      this.values.set(d.key, structuredClone(d.default));
    }
    this.groups.push(group);
  }

  def(key: string) {
    return this.defs.get(key);
  }

  get<T extends SettingValue>(key: string): T {
    if (!this.values.has(key)) throw new Error(`Unknown setting ${key}`);
    return this.values.get(key) as T;
  }
  num(key: string) { return this.get<number>(key); }
  bool(key: string) { return this.get<boolean>(key); }
  str(key: string) { return this.get<string>(key); }
  vec(key: string) { return this.get<[number, number, number]>(key); }

  set(key: string, value: SettingValue) {
    if (!this.defs.has(key)) return;
    this.values.set(key, value);
    for (const l of this.listeners) l(key, value);
  }

  /** Set many at once, e.g. when a .vox file supplies its render settings. */
  apply(values: Record<string, SettingValue>) {
    for (const [k, v] of Object.entries(values)) this.set(k, v);
  }

  resetToDefaults() {
    for (const d of this.defs.values()) this.set(d.key, structuredClone(d.default));
  }

  snapshot(): Record<string, SettingValue> {
    return Object.fromEntries(this.values);
  }

  onChange(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
