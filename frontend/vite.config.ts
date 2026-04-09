import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const proxyTarget = env.VITE_PROXY_TARGET?.trim();
  const proxyUrl = proxyTarget ? new URL(proxyTarget) : null;

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: [
          'icon.svg',
          'icon-maskable.svg',
          'icon-192.png',
          'icon-512.png',
          'icon-maskable-512.png',
          'apple-touch-icon.png'
        ],
        manifest: {
          id: '/',
          name: 'Window Film Inventory',
          short_name: 'FilmInventory',
          description: 'Window film inventory, jobs, and allocation workspace.',
          theme_color: '#12343b',
          background_color: '#f3f5f7',
          display: 'standalone',
          scope: '/',
          start_url: '/',
          icons: [
            {
              src: 'icon-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any'
            },
            {
              src: 'icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any'
            },
            {
              src: 'icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable'
            },
            {
              src: 'icon.svg',
              sizes: 'any',
              type: 'image/svg+xml',
              purpose: 'any'
            },
            {
              src: 'icon-maskable.svg',
              sizes: 'any',
              type: 'image/svg+xml',
              purpose: 'maskable'
            }
          ]
        },
        workbox: {
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
          skipWaiting: true,
          runtimeCaching: [
            {
              urlPattern: ({ request }) => request.destination === 'image',
              handler: 'CacheFirst',
              options: {
                cacheName: 'image-cache',
                expiration: {
                  maxEntries: 40,
                  maxAgeSeconds: 60 * 60 * 24 * 30
                }
              }
            },
            {
              urlPattern: ({ url }) => url.pathname.startsWith('/api'),
              handler: 'NetworkFirst',
              options: {
                cacheName: 'api-cache',
                networkTimeoutSeconds: 5
              }
            }
          ]
        }
      })
    ],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) {
              return undefined;
            }

            if (id.includes('html5-qrcode') || id.includes('qrcode')) {
              return 'vendor-scanner';
            }

            return 'vendor';
          }
        }
      }
    },
    server: proxyUrl
      ? {
          proxy: {
            '/api': {
              target: proxyUrl.origin,
              changeOrigin: true,
              followRedirects: true,
              secure: false,
              rewrite: (path) => `${proxyUrl.pathname}${path.replace(/^\/api/, '')}`
            }
          }
        }
      : undefined
  };
});
