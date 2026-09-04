import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./src/desktop/renderer", import.meta.url)),
  base: "./",
  publicDir: false,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5178,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/desktop/renderer", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
});
