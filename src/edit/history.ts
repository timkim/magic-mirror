// Undo/redo for every change to the scene. Editor tools, panels and (later) the AI assistant
// all go through here, so each change has a label and can be undone the same way.

import { writable } from 'svelte/store';

export interface Command {
  label: string;
  apply(): void;
  revert(): void;
}

export class History {
  private done: Command[] = [];
  private undone: Command[] = [];
  /** Labels for the UI: what Undo and Redo would do next. */
  readonly state = writable<{ undo?: string; redo?: string; count: number }>({ count: 0 });
  /** Changes since the last save. */
  dirty = false;

  constructor(private limit = 500) {}

  /** Apply a command and record it. */
  run(cmd: Command) {
    cmd.apply();
    this.push(cmd);
  }

  /** Record a command whose effect is already applied (e.g. a finished brush stroke). */
  push(cmd: Command) {
    this.done.push(cmd);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
    this.changed();
  }

  undo() {
    const c = this.done.pop();
    if (!c) return null;
    c.revert();
    this.undone.push(c);
    this.changed();
    return c.label;
  }

  redo() {
    const c = this.undone.pop();
    if (!c) return null;
    c.apply();
    this.done.push(c);
    this.changed();
    return c.label;
  }

  clear() {
    this.done = [];
    this.undone = [];
    this.dirty = false;
    this.changed(false);
  }

  private changed(dirty = true) {
    if (dirty) this.dirty = true;
    this.state.set({ undo: this.done.at(-1)?.label, redo: this.undone.at(-1)?.label, count: this.done.length });
  }
}
