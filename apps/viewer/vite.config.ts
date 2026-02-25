import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  server: {
    proxy: {
      '/zarr': {
        target: 'https://dl2.geotessera.org',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@ucam-eo/maplibre-zarr-tessera': path.resolve(
        __dirname, '../../packages/maplibre-zarr-tessera/src/index.ts'
      ),
    },
  },
});
