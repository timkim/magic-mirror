import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    // Components receive the one App object (and setting definitions) for their whole lifetime
    // and read them once on purpose, so "only captures the initial value" is expected here.
    warningFilter: (w) => w.code !== 'state_referenced_locally',
  },
};
