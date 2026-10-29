import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { browserWasm } from "./scripts/browser-wasm";

// GitHub Pages project site: https://gbeurier.github.io/nirs4all-preflight/
export default defineConfig({
  base: "/nirs4all-preflight/",
  plugins: [react(), browserWasm()],
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: true },
});
