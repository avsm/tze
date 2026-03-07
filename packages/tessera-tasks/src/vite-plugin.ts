import path from 'path';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import type { Plugin } from 'vite';

/**
 * Vite plugin that copies onnxruntime-web WASM files to public/ort-wasm/
 * and serves .mjs files with correct MIME type in dev mode.
 *
 * ORT uses dynamic import() to load its WASM glue .mjs files. In Vite dev,
 * files in public/ served as .mjs get intercepted by Vite's module graph
 * (adding ?import suffix), which breaks them. We serve them via a raw
 * middleware before Vite's transform pipeline touches them.
 */
export function ortWasmPlugin(): Plugin {
  let destDir: string;

  return {
    name: 'tessera-tasks-ort-wasm',
    configResolved(config) {
      destDir = path.resolve(config.root, 'public/ort-wasm');
    },
    buildStart() {
      // Locate onnxruntime-web package
      const require = createRequire(import.meta.url);
      const ortPkg = require.resolve('onnxruntime-web/package.json');
      const srcDir = path.resolve(path.dirname(ortPkg), 'dist');

      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
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
    configureServer(server) {
      server.middlewares.use((req: any, res: any, next: any) => {
        const url = req.url?.split('?')[0];
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
