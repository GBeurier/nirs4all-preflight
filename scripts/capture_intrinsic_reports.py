#!/usr/bin/env python3
"""Capture native protocol evidence for the independent WASM conformance gate."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", type=Path, required=True)
    parser.add_argument("--methods-library", type=Path, required=True)
    parser.add_argument("--methods-source-commit", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    source_sha = subprocess.check_output(["git","rev-parse","HEAD"],cwd=root,text=True).strip()
    fixture = root/"crates/nirs4all-preflight/tests/fixtures/intrinsic_legacy_v1.json"
    cli, library = args.cli.resolve(), args.methods_library.resolve()
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    initial = {"cli":digest(cli),"methods_library":digest(library),"fixture":digest(fixture)}
    cases = []
    with tempfile.TemporaryDirectory(prefix="n4pf-intrinsic-") as directory:
        for case in json.loads(fixture.read_text())["cases"]:
            path = Path(directory)/f'{case["id"]}.json'
            path.write_text(json.dumps(case["input"],allow_nan=False))
            process = subprocess.run([str(cli),"analyze",str(path),"--methods-library",str(library)],cwd=directory,capture_output=True,text=True,check=True)
            report = json.loads(process.stdout)
            assert report["validation"]["valid"],report["validation"]
            metrics = [metric for metric in report["metrics"] if metric["metric_id"].startswith("intrinsic.")]
            assert metrics and not any(metric["status"]=="error" for metric in metrics),[(m["metric_id"],m["reason_code"]) for m in metrics if m["status"]=="error"]
            cases.append({"id":case["id"],"metrics":metrics})
    assert initial=={"cli":digest(cli),"methods_library":digest(library),"fixture":digest(fixture)}
    result = {"schema_version":1,"preflight_source_sha":source_sha,"methods_source_sha":args.methods_source_commit,"artifacts_sha256":initial,"cases":cases}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2,allow_nan=False)+"\n")
    print(json.dumps({"output":str(args.output),"cases":len(cases),"preflight_source_sha":source_sha,"metrics":[len(c["metrics"]) for c in cases]}))


if __name__=="__main__":
    main()
