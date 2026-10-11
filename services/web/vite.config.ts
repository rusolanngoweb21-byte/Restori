import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  publicDir: root + "public",
  plugins: [react()],
  resolve: { alias: { "@": root } },
  css: { postcss: root },
  build: { outDir: root + "dist-web", emptyOutDir: true, sourcemap: false },
});
