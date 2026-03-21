import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  plugins: [cesium()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 5000,
  },
  optimizeDeps: {
    exclude: ['cesium'],
  },
});
