import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// GitHub Pages project site: https://gbeurier.github.io/nirs4all-preflight/
export default defineConfig({
  base: "/nirs4all-preflight/",
  plugins: [react()],
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: true },
});
