import { writable } from 'svelte/store';

/** The loaded reference image (object URL), shared by the toolbar button and the overlay. */
export const reference = writable<{ url: string; name: string; width: number; height: number } | null>(null);
