import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  envPrefix: ['VITE_'],
  build: {
    rollupOptions: {
      output: {
        // Keep the formula renderer separate from the canvas and application UI.
        manualChunks(id) {
          if (id.includes('/node_modules/katex/')) return 'math-renderer';
        },
      },
    },
  },
});
