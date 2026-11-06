#!/usr/bin/env python3
"""Check local spec links and emit a deterministic digest of the design sources."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]

def source_paths(root: Path) -> list[Path]:
    paths = [p for p in root.glob('*.md') if p.name != 'AGENTS.md']
    for folder in ('specs', 'decisions'):
        paths.extend((root / folder).rglob('*.md'))
    return sorted(paths)

def snapshot(root: Path) -> dict:
    entries = []
    errors = []
    for path in source_paths(root):
        relative = path.relative_to(root).as_posix()
        raw = path.read_bytes()
        text = raw.decode('utf-8')
        entries.append({'path': relative, 'sha256': hashlib.sha256(raw).hexdigest()})
        if not text.startswith('# '):
            errors.append(f'{relative}: missing document title')
        for target in re.findall(r'\[[^\]]+\]\(([^\s)]+)(?:\s+"[^"]*")?\)', text):
            if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', target) or target.startswith('#'):
                continue
            destination = (path.parent / target.split('#', 1)[0]).resolve()
            if not destination.is_relative_to(root.resolve()):
                errors.append(f'{relative}: link leaves specification workspace: {target}')
            elif not destination.exists():
                errors.append(f'{relative}: broken local link: {target}')
    encoded = json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()
    return {'format': 1, 'sha256': hashlib.sha256(encoded).hexdigest(),
            'files': entries, 'errors': errors,
            'scope': 'Top-level Markdown (except agent instructions), specs/, decisions/. '
                     'Review records and rendered artifacts are excluded to avoid recursive digests.',
            'limits': 'Checks file presence and local file links only; does not prove semantic '
                      'consistency, external URL availability, or implementation behavior.'}

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--verify', type=Path, help='Compare source digest with a saved snapshot.')
    args = parser.parse_args()
    result = snapshot(ROOT)
    if args.verify:
        expected = json.loads(args.verify.read_text())
        result['matches'] = expected['sha256'] == result['sha256']
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    return int(bool(result['errors']) or result.get('matches') is False)

if __name__ == '__main__':
    sys.exit(main())
