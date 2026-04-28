import { defineConfig } from "vite";

export default defineConfig({
  publicDir: 'static',
  server: {
    open: "/index.html",
  },
  build: {
    outDir: "./dist",
    emptyOutDir: true
  },
  base: './'
});