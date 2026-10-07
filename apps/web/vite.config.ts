import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/** Gateway the dev/preview servers proxy to (same-origin in production). */
const gateway = process.env.OPENCOACH_GATEWAY ?? 'http://127.0.0.1:8787';

const proxy: Record<string, string | ProxyOptions> = {
  '/v1': { target: gateway, ws: true, changeOrigin: false },
  '/admin': { target: gateway, changeOrigin: false },
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // Registered manually in src/lib/pwa.ts (production only).
      injectRegister: false,
      registerType: 'prompt',
      manifest: {
        name: 'OpenCoach',
        short_name: 'OpenCoach',
        description: 'Your AI coach, for any sport.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#ffffff',
        theme_color: '#E4572E',
        categories: ['health', 'fitness', 'sports'],
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
      },
    }),
  ],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  build: { target: 'es2022', sourcemap: false },
});
