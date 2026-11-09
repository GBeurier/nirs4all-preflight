# nirs4all-preflight

Exploratory alpha of the NIRS dataset qualification engine. A thin Python facade calls one Rust core; numerical diagnostics come from the public nirs4all-methods C ABI. Platform wheels contain the Rust C ABI and depend on the matching published `nirs4all-methods==1.3.15` wheel for its native Methods C ABI. They do not require the full Python nirs4all or scikit-learn installation.

```python
import json
from nirs4all_preflight import analyze, validate, report_html
with open('dataset.json') as f:
    dataset = json.load(f)
print(validate(dataset))
report = analyze(dataset)
with open('report.html', 'w') as f:
    f.write(report_html(report))
```

Inputs must follow the canonical JSON schema shown in the repository examples. Dataset assembly and vendor decoding remain in nirs4all-io and nirs4all-formats. The grouped PLS/PCR validation probe runs through DAG-ML nested selection and is exploratory, as is clustering. Version 0.1.7 does not include calibrated inferential tests, qualified clustering or domain shift. Capabilities and limitations are present in every report.

`N4PF_LIBRARY_PATH` selects the Rust C ABI library; `N4M_LIBRARY_PATH` selects a compatible Methods library (ABI 2.20 or newer). Each analysis owns a separate native context. The Python binding does not implement scientific calculations.

Build from a checkout with `cargo build --locked --release -p nirs4all-preflight-capi`, then `python scripts/stage-python.py` and `python -m build --wheel bindings/python`. The release workflow builds and repairs Linux wheels for the manylinux 2.28 profile before testing and publishing them. Linux musl, Windows ARM64, source distributions and other untested profiles are not provided. The Methods owner package controls its native library and dependencies. For an external Methods library use `N4M_LIBRARY_PATH` or the explicit argument; an external `N4M_LIB_PATH` alone is rejected.
