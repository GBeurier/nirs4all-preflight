# nirs4all-preflight

Exploratory alpha of the NIRS dataset qualification engine. A thin Python facade calls one Rust core; numerical diagnostics come from the public nirs4all-methods C ABI. Linux wheels bundle both libraries and need no full Python nirs4all or scikit-learn installation.

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

Inputs must follow the canonical JSON schema shown in the repository examples. Dataset assembly and vendor decoding remain in nirs4all-io and nirs4all-formats. The grouped PLS/PCR validation probe runs through DAG-ML nested selection and is exploratory, as is clustering. The alpha does not include calibrated inferential tests, qualified clustering or domain shift. Capabilities and limitations are present in every report.

`N4PF_LIBRARY_PATH` selects the Rust C ABI library; `N4M_LIBRARY_PATH` selects a compatible Methods library (ABI 2.20 or newer). Each analysis owns a separate native context. The Python binding does not implement scientific calculations.
