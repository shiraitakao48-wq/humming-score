import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [
        "apple-touch-icon.png",
        "pwa-icon-192.png",
        "pwa-icon-512.png"
      ],
      manifest: {
        id: "/",
        name: "Humming Score",
        short_name: "HummingScore",
        description: "鼻歌・口笛から楽譜を自動生成します。",
        lang: "ja",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f2f4f8",
        theme_color: "#182b42",
        icons: [
          {
            src: "/pwa-icon-192.png",
            sizes: "192x192",
            type: "image/png"
          },
          {
            src: "/pwa-icon-512.png",
            sizes: "512x512",
            type: "image/png"
          },
          {
            src: "/pwa-icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable"
          }
        ]
      },
      workbox: {
        globPatterns: [
          "**/*.{js,css,html,ico,png,svg,webmanifest,json,bin}"
        ],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024
      }
    })
  ]
});
