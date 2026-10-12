#!/usr/bin/env python3
"""Stage built upstream libraries into the platform wheel; never commit them."""
import argparse
import shutil
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--methods-library', type=Path, required=True)
parser.add_argument('--preflight-library', type=Path, default=Path('target/release/libnirs4all_preflight_capi.so'))
args = parser.parse_args()
out = Path(__file__).resolve().parents[1] / 'bindings/python/src/nirs4all_preflight/_native'
out.mkdir(parents=True, exist_ok=True)
shutil.copy2(args.preflight_library, out / args.preflight_library.name)
shutil.copy2(args.methods_library, out / 'libn4m.so.2')
