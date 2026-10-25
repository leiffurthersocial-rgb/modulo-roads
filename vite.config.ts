import { defineConfig } from 'vite';

// Relative base so the build works from any sub-path (GitHub Pages, Netlify, a USB stick...).
export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: {
    target: 'es2020', // Safari 14+ on iPad
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: { manualChunks: { three: ['three'] } },
    },
  },
});
