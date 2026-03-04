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
        registerType: 'prompt',
        includeAssets: ['icon.svg', 'icon-maskable.svg'],
        manifest: {
          name: 'Window Film Inventory',
          short_name: 'FilmInventory',
          theme_color: '#12343b',
          background_color: '#f3f5f7',
          display: 'standalone',
          start_url: './',
          icons: [
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
          globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
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
