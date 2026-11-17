import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: `${appRoot}src/renderer`,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@shared": `${appRoot}src/shared`,
      "@": `${appRoot}src`,
    },
  },
  server: { port: 1420, strictPort: true },
  clearScreen: false,
  build: {
    outDir: `${appRoot}dist`,
    emptyOutDir: true,
  },
});
