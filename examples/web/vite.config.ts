import { resolve } from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [vue()],
  build: {
    outDir: resolve(import.meta.dirname, "../../.local/web-dist"),
    emptyOutDir: true,
  },
});
