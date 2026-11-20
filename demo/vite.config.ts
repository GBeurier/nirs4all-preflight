import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { browserWasm } from "./scripts/browser-wasm";

// GitHub Pages project site: https://gbeurier.github.io/nirs4all-preflight/
export default defineConfig({
  base: "/nirs4all-preflight/",
  plugins: [react(), browserWasm()],
  worker: { format: "es" },
  // Keep package-relative WASM URLs intact in development as well as production.
  optimizeDeps: { exclude: ["@nirs4all/preflight", "@nirs4all/methods", "dag-ml-wasm", "dag-ml-wasm/n4m-controller"] },
  server: { fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
  build: { target: "es2022", sourcemap: true, ...(process.env.PREFLIGHT_PROFILE === "1" ? { rollupOptions: { input: { main: fileURLToPath(new URL("./index.html", import.meta.url)), profile: fileURLToPath(new URL("./profile.html", import.meta.url)) } } } : {}) },
});
