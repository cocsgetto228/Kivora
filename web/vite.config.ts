import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The web client is deliberately a plain Vite + React app with no UI framework
// and no state library: the whole bundle is the messenger, not a dependency
// tree. See docs/LIGHTWEIGHT.md for what that buys.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@kivora/crypto": fileURLToPath(new URL("../packages/kivora-crypto/src/index.ts", import.meta.url)),
    },
  },
  build: {
    target: "es2022",
    // Keeping this modest makes an oversized dependency impossible to miss.
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      output: {
        manualChunks: {
          crypto: ["@kivora/crypto"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.KIVORA_SERVER ?? "http://localhost:8080",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
