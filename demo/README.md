# nirs4all-preflight demo

Static Vite/React application published at https://gbeurier.github.io/nirs4all-preflight/. It accepts canonical JSON already assembled by the host and runs the real Rust and Methods WASM engines in a worker. No scientific calculation or vendor parser lives in the page.

`src/engine.ts` owns worker messages and cancellation; `src/runtime.ts` loads the distributed `@nirs4all/preflight` package. `nirs4all-ui/qualification` supplies shared presentation components. Source/target controls filter displayed report rows; the engine always receives all sources and targets. Each report retains the exact input, populations, context, availability and synthetic origin.

Dependencies are pinned to published packages. Run `npm ci`, `npm test`, `npm run build` and `npm run preview`. `.github/workflows/pages.yml` builds and publishes the project site.

The profile is exploratory alpha. Advanced protocols and language/platform qualification limits are listed in the engine report. Browser checks cover headless Chromium, including the real WASM analysis, PCA and text table, downloads, cancellation, stale responses and narrow layouts; screen-reader and other-browser qualification remain open.
