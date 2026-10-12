# Python wheel validation (2026-10-13)

The release candidate is `nirs4all_preflight-0.1.0a1-py3-none-linux_x86_64.whl` at `/tmp/nirs4all-preflight-agents/dist/`. SHA-256: `3f7488280941c97da899c7e7c49f83aaab8b1542a5ffae453a523b04142d3eb7`.

The wheel was built from the latest Rust C API release and nirs4all-methods 1.3.5 (ABI 2.18) built with the `dev-release` CMake preset. Only copied libraries in the Python staging directory were stripped. The wheel has tag `py3-none-linux_x86_64`, contains both native libraries, and was installed and run under CPython 3.11.15. This is a Linux x86-64 artifact only; macOS, Windows, other architectures, and Linux distribution compatibility were not qualified. The `linux_x86_64` tag does not claim a manylinux baseline.

Build and installation commands:

```sh
cargo build --release -p nirs4all-preflight-capi -p nirs4all-preflight-cli
cmake --preset dev-release  # in nirs4all-methods
cmake --build --preset dev-release -j 4  # in nirs4all-methods
python3.11 scripts/stage-python.py --methods-library /home/delete/nirs4all/nirs4all-methods/build/dev-release/cpp/src/libn4m.so.2.18.0
strip --strip-unneeded bindings/python/src/nirs4all_preflight/_native/libn4m.so.2 bindings/python/src/nirs4all_preflight/_native/libnirs4all_preflight_capi.so
cd bindings/python && uv build --wheel --out-dir /tmp/nirs4all-preflight-agents/dist
uv pip install --python /tmp/nirs4all-preflight-wheel-smoke/bin/python /tmp/nirs4all-preflight-agents/dist/nirs4all_preflight-0.1.0a1-py3-none-linux_x86_64.whl --force-reinstall
```

The smoke runner at `/tmp/nirs4all-preflight-agents/wheel_smoke.py` was executed from `/tmp` using the installed Python 3.11 environment. It asserted that the package import resolved inside that environment and that the source checkout was absent from `sys.path`. For each fixture, `validate()` and `analyze()` matched the Release CLI output exactly. It also checked Rust-generated HTML, scoped metric/version fields, finding confidence, and computed PCA eigenvalues/scores/full variance moments, target summary, and local contrast.

| Fixture | Metrics | Findings | Additional checks |
| --- | ---: | ---: | --- |
| `examples/first_run.json` | 19 | 0 | `data_origin=synthetic`; 5 development and 1 retained-test sample; target summary count 5; repeatability correctly not applicable |
| `after-clean.json` | 19 | 0 | 24 development and 6 retained-test samples |
| `after-pitfalls.json` | 22 | 1 | Two computed per-band repeatability results; undocumented exact-repeat finding |
| `xpartition-dup.json` | 19 | 1 | One exact development/retained-test spectral pair; cross-partition duplicate finding with explicit confidence |

The three existing Python binding tests also passed against the installed wheel:

```sh
cd /tmp
/tmp/nirs4all-preflight-wheel-smoke/bin/python /tmp/nirs4all-preflight-agents/wheel_smoke.py
/tmp/nirs4all-preflight-wheel-smoke/bin/python -m pytest -q /home/delete/nirs4all/nirs4all-preflight/bindings/python/tests/test_binding.py
# 3 passed
```

The build uses setuptools' integrated `bdist_wheel`; `wheel` is no longer a direct build dependency. Python build and egg-info directories are ignored in `.gitignore`.
