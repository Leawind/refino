import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// Default address of the `refino web` backend, used in development to proxy
// API requests so the dev server and the built app behave identically.
const backendHost = process.env.REFINO_WEB_HOST ?? "127.0.0.1";
const backendPort = process.env.REFINO_WEB_PORT ?? "5649";

export default defineConfig({
  plugins: [vue()],
  base: "./",
  build: {
    outDir: "dist",
  },
  server: {
    proxy: {
      "/api": `http://${backendHost}:${backendPort}`,
    },
  },
});
