import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { ortWasmPlugin } from '@ucam-eo/tessera-tasks/vite';

export default defineConfig({
  base: '/',
  plugins: [svelte(), tailwindcss(), ortWasmPlugin()],
  server: {
    proxy: {
      '/zarr': 'http://localhost:9999',
    },
  },
  resolve: {
    alias: {
      '@ucam-eo/maplibre-tessera': path.resolve(
        __dirname, '../../packages/maplibre-tessera/src/index.ts'
      ),
      '@ucam-eo/tessera-tasks/classify': path.resolve(
        __dirname, '../../packages/tessera-tasks/src/classify.ts'
      ),
      '@ucam-eo/tessera-tasks/segment': path.resolve(
        __dirname, '../../packages/tessera-tasks/src/segment.ts'
      ),
      '@ucam-eo/tessera-tasks': path.resolve(
        __dirname, '../../packages/tessera-tasks/src/index.ts'
      ),
    },
  },
});
