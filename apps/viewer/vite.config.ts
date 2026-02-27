import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';

/**
 * Copy onnxruntime-web dist files (.wasm + .mjs) to public/ort-wasm/
 * and serve .mjs files with correct MIME type in dev mode.
 *
 * ORT uses dynamic import() to load its WASM glue .mjs files. In Vite dev,
 * files in public/ served as .mjs get intercepted by Vite's module graph
 * (adding ?import suffix), which breaks them. We serve them via a raw
 * middleware before Vite's transform pipeline touches them.
 */
function ortWasmPlugin() {
  const destDir = path.resolve(__dirname, 'public/ort-wasm');
  return {
    name: 'ort-wasm',
    buildStart() {
      const srcDir = path.resolve(__dirname, 'node_modules/onnxruntime-web/dist');
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
      // Only copy files needed for the WASM execution provider
      for (const file of [
        'ort-wasm-simd-threaded.wasm',
        'ort-wasm-simd-threaded.jsep.wasm',
        'ort-wasm-simd-threaded.mjs',
        'ort-wasm-simd-threaded.jsep.mjs',
      ]) {
        const src = path.join(srcDir, file);
        if (existsSync(src)) cpSync(src, path.join(destDir, file));
      }
    },
    configureServer(server: any) {
      // Serve /ort-wasm/*.mjs as raw JS before Vite's transform middleware
      server.middlewares.use((req: any, res: any, next: any) => {
        const url = req.url?.split('?')[0]; // strip ?import etc.
        if (url?.startsWith('/ort-wasm/') && url.endsWith('.mjs')) {
          const filePath = path.join(destDir, path.basename(url));
          if (existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/javascript');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(readFileSync(filePath));
            return;
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [svelte(), tailwindcss(), ortWasmPlugin()],
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
