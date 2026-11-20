#!/usr/bin/env python3
"""Stage the built Preflight C ABI into the platform wheel; never commit it."""
import argparse
import shutil
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
suffix = ".dll" if sys.platform == "win32" else ".dylib" if sys.platform == "darwin" else ".so"
name = "nirs4all_preflight_capi.dll" if sys.platform == "win32" else "libnirs4all_preflight_capi" + suffix
parser.add_argument("--preflight-library", type=Path, default=Path("target/release") / name)
args = parser.parse_args()
out = Path(__file__).resolve().parents[1] / "bindings/python/src/nirs4all_preflight/_native"
shutil.rmtree(out, ignore_errors=True)
out.mkdir(parents=True, exist_ok=True)
shutil.copy2(args.preflight_library, out / name)
