import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // Build stamp shown in Settings → About (and on <html data-build>) to tell versions apart.
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC') },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'HIW Trainer · PTE Highlight Incorrect Words',
        short_name: 'HIW Trainer',
        description: 'PTE Highlight Incorrect Words trainer: tracking, scoring and adaptive practice.',
        lang: 'en',
        start_url: '/',
        display: 'standalone',
        background_color: '#f7f7f5',
        theme_color: '#256abf',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // App shell + exercise library are precached; audio is cached on first use.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}', 'content/*.json'],
        // The exercise library (~2.3 MB, ~400 KB gzipped) must be precached for offline practice.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/audio/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'hiw-audio',
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 400 },
            },
          },
        ],
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
