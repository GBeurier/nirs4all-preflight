#!/usr/bin/env python3
"""Publish a reviewed tarball; pass npm credentials through stdin, never argv."""
import argparse
import os
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--token-file',type=Path,required=True)
parser.add_argument('--tarball',type=Path)
parser.add_argument('--tag',default='alpha')
args=parser.parse_args()
token=args.token_file.read_text().strip()
config=f'//registry.npmjs.org/:_authToken={token}\nregistry=https://registry.npmjs.org/\n'
command=['npm','--loglevel','error','--userconfig','/dev/stdin','whoami'] if args.tarball is None else ['npm','--loglevel','error','--userconfig','/dev/stdin','publish',str(args.tarball.resolve()),'--access','public','--provenance=false','--ignore-scripts','--tag',args.tag]
raise SystemExit(subprocess.run(command,input=config,text=True,env=os.environ.copy()).returncode)
