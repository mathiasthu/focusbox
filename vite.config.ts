import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const isTauri = !!process.env.TAURI_ENV_PLATFORM || !!host;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // SHELL ONLY. Never precache the API. Only hashed app assets + the fonts.
      workbox: {
        globPatterns: ["**/*.{js,css,html,woff2,svg,png,ico}"],
        // Belt-and-suspenders: never let the SW intercept the sync API.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
      includeAssets: ["favicon.svg", "favicon-32.png", "apple-touch-icon.png"],
      manifest: {
        name: "Focusbox",
        short_name: "Focusbox",
        description: "A deliberately minimal focus app: timer, tasks, and notes.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        theme_color: "#bf5a2f",
        background_color: "#faf7f2",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-256.png", sizes: "256x256", type: "image/png" },
          { src: "/icons/icon-384.png", sizes: "384x384", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],

  // Vite options tailored for Tauri development; only the dev server is Tauri-specific.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
