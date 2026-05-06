import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      // Without this denylist the service worker's SPA navigation fallback
      // (index.html) intercepts requests like /api/submissions/.../photos/foo.jpg
      // and serves the React app's HTML in place of the JPEG — clicking a
      // photo "redirects to a funny link" instead of showing the image.
      // Excluding /api/ and /health/ lets those requests hit the network.
      workbox: {
        navigateFallbackDenylist: [/^\/api\//, /^\/health/],
      },
      manifest: {
        name: "Task Upater",
        short_name: "Tasks",
        description: "Field-tech task updater",
        theme_color: "#0a0d12",
        background_color: "#0a0d12",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
});
