# @nirs4all/preflight

Portable Rust qualification protocols. Reusable numerical diagnostics are supplied by `@nirs4all/methods`, with one Emscripten instance in the same worker.

```js
import { createQualificationRuntime } from '@nirs4all/preflight';
const runtime = await createQualificationRuntime();
const report = runtime.analyze(alreadyAssembledDataset);
```

Use a dedicated worker for large inputs. Cancel by terminating that worker; stale responses must be discarded by the host. No input is sent to a server. This alpha profile is exploratory; advanced validation, clustering qualification and five-language qualification gates remain open. Requires `@nirs4all/methods` with ABI 2.20 (HDBSCAN, ARI, correlation, exact permutation, Benjamini–Hochberg, PERMANOVA, PERMDISP and one-way variance components kernels). Root seeds above 2^53 must be passed as a bigint or a decimal string. `analyzeJson(text)` and `validateJson(text)` hand JSON text to the engine unchanged, so no number is rounded or decoded by JavaScript. See the capabilities and limitations in each report.
