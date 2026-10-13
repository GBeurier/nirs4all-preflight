# @nirs4all/preflight

Portable Rust qualification protocols. Reusable numerical diagnostics are supplied by `@nirs4all/methods`, with one Emscripten instance in the same worker.

```js
import { createQualificationRuntime } from '@nirs4all/preflight';
const runtime = await createQualificationRuntime();
const report = runtime.analyze(alreadyAssembledDataset);
```

Use a dedicated worker for large inputs. Cancel by terminating that worker; stale responses must be discarded by the host. No input is sent to a server. This alpha profile is exploratory; advanced validation, clustering qualification and five-language qualification gates remain open. Requires `@nirs4all/methods` with ABI 2.20 (HDBSCAN, ARI, cluster Jaccard, linear sum assignment, PCG64 permutations and Gaussian draws). See the capabilities and limitations in each report.
