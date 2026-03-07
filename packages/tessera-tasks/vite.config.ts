import { defineConfig } from 'vite';
import { cpSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: './src/index.ts',
        'vite-plugin': './src/vite-plugin.ts',
      },
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [
        '@ucam-eo/maplibre-zarr-tessera',
        '@tensorflow/tfjs-core',
        '@tensorflow/tfjs-backend-webgl',
        'onnxruntime-web',
        'path',
        'fs',
        'module',
        'vite',
      ],
    },
  },
  plugins: [
    {
      name: 'copy-models',
      closeBundle() {
        const destDir = path.resolve(__dirname, 'dist/models');
        const srcDir = path.resolve(__dirname, 'models');
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
        for (const file of ['solar_unet.onnx', 'solar_unet_stats.json']) {
          const src = path.join(srcDir, file);
          if (existsSync(src)) cpSync(src, path.join(destDir, file));
        }
      },
    },
  ],
});
