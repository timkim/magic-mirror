import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built app works from any folder or static host.
  base: './',
  server: { host: true }, // reachable from other PCs on the LAN (for future network rendering)
});
