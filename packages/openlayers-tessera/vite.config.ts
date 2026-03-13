import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: './src/index.ts',
      name: 'OpenLayersTessera',
      formats: ['es', 'cjs'],
      fileName: 'index',
    },
    rollupOptions: {
      external: ['ol', 'ol/source/XYZ', 'ol/layer/Tile', '@ucam-eo/tessera'],
    },
  },
});
