import path from 'node:path';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  resolve: { alias: { $lib: path.resolve('./src/lib') } },
  // Relative base so the built app works from any folder or static host.
  base: './',
  server: { host: true }, // reachable from other PCs on the LAN
});
