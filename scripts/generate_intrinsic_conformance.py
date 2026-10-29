#!/usr/bin/env python3
"""Retain a legacy characterization, never a new runtime dependency/kernel.

Use an explicit clean Datasets checkout. The generated matrices are original
synthetic fixtures; no catalog spectra or private data are copied.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

import numpy as np
import scipy


def make_input(matrix: list[list[float | None]], case_id: str) -> dict:
    n, p = len(matrix), len(matrix[0])
    return {
        "schema_version": 1,
        "data_origin": "synthetic",
        "samples": [{"sample_id": f"sample-{i}", "physical_sample_id": f"physical-{i // 2}", "partition": "development", "instrument": "synthetic-device", "campaign": "fixture"} for i in range(n)],
        "sources": [{"source_id": case_id, "observation_ids": [f"obs-{i}" for i in range(n)], "sample_ids": [f"sample-{i}" for i in range(n)], "x": matrix, "axis": [1000. + 2 * j for j in range(p)], "axis_unit": "nm", "signal_unit": "a.u.", "signal_type": "absorbance"}],
        "targets": [],
        "options": {"independence_unit": "unknown", "snv_sensitivity": False, "intrinsic_qc": {"local_density": True, "n_neighbors": 3}},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.legacy_root.resolve()
    relative = "src/nirs4all_datasets/qualify/metrics.py"
    source = root / relative
    source_bytes = source.read_bytes()
    committed = subprocess.check_output(["git", "show", f"HEAD:{relative}"], cwd=root)
    if source_bytes != committed:
        raise SystemExit("Legacy metrics must match the explicitly selected commit")
    spec = importlib.util.spec_from_file_location("legacy_dataset_metrics", source)
    legacy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(legacy)
    # Vary gain, offset and curvature; two independently identified fixture
    # observations per physical ID. No independence or technical-repeat claim.
    matrix = [[(1. + r * 0.09) * (1. + j / 13. + (j % 5) * 0.04) + r * 0.03 + ((r + j) % 3 - 1) * 0.007 for j in range(33)] for r in range(8)]
    matrix[1][15] += 10.
    matrix[5][24:] = [v + 5. for v in matrix[5][24:]]
    missing = [row[:] for row in matrix]
    missing[0][3] = None
    missing[2] = [None] * 33
    cases = []
    for case_id, x, annotation in [
        ("complete", matrix, "Complete finite data: reference, global noise and index events agree; true LOF is separately compared to sklearn, not the legacy distance-ratio proxy."),
        ("masked", missing, "Intentional difference: legacy reference column-imputes the all-missing observation; the new pairwise-valid protocol keeps it unavailable. Event fractions use eligible differences, not full rectangular shape."),
        ("zero_norm", [[0.] * 8 for _ in range(4)], "Intentional difference: RMS to a zero reference is defined as zero; SAM and affine gain are undefined. Zero noise is measured zero; a ratio with zero noise is unavailable."),
        ("constant_reference", [[float(r + 1)] * 8 for r in range(4)], "Constant reference makes affine gain/offset unavailable. RMS and SAM retain their independently defined availability."),
    ]:
        input_value = make_input(x, case_id)
        arr = np.asarray([[np.nan if v is None else v for v in row] for row in x], dtype=np.float64)
        axis = input_value["sources"][0]["axis"]
        expected = {"reference": legacy.reference_similarity(arr, axis), "noise": legacy.spectral_noise(arr, axis), "events": legacy.spectral_artefacts(arr)}
        cases.append({"id": case_id, "annotation": annotation, "input": input_value, "legacy": expected})
    document = {
        "schema_version": 1,
        "provenance": {"data": "original synthetic analytical fixture; no real spectra", "legacy_repository": "https://github.com/GBeurier/nirs4all-datasets", "legacy_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(), "legacy_path": relative, "legacy_sha256": hashlib.sha256(source_bytes).hexdigest(), "numpy": np.__version__, "scipy": scipy.__version__},
        "comparison": {"relative_tolerance": 2e-11, "absolute_tolerance": 2e-12, "sam_absolute_tolerance_rad": 2e-10, "count_and_status_comparison": "exact"},
        "cases": cases,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"output": str(args.output), "cases": len(cases), "legacy_sha256": document["provenance"]["legacy_sha256"]}))


if __name__ == "__main__":
    main()
