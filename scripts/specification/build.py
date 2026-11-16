#!/usr/bin/env python3
"""Package the current specification documents as one offline HTML view."""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

from spec_model import REPO, ShapeError, build_model

ROOT = Path(__file__).resolve().parent
PRIVATE_CONTEXT = re.compile(r'/home/|/Users/|[A-Za-z]:\\Users\\|ahillspace|solutions engineering team|Google/Salesforce|Google/staff', re.I)


def main():
    try:
        model = build_model()
    except ShapeError as error:
        raise SystemExit(f'Specification shape changed: {error}')
    for source in model['sources']:
        path = REPO / source['path']
        source['content'] = path.read_text()
        source['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
    rendered = subprocess.run(['node', str(ROOT / 'render-documents.cjs')], input=json.dumps(model['sources']),
                              text=True, capture_output=True)
    if rendered.returncode:
        raise SystemExit(rendered.stderr)
    model['sources'] = json.loads(rendered.stdout)
    for source in model['sources']:
        del source['content']
    template = (ROOT / 'template.html').read_text()
    html = template.replace('/*__STYLE__*/', (ROOT / 'template.css').read_text())
    html = html.replace('/*__MODEL__*/', json.dumps(model, ensure_ascii=False).replace('</', '<\\/'))
    html = html.replace('/*__SCRIPT__*/', (ROOT / 'template.js').read_text())
    if PRIVATE_CONTEXT.search(html):
        raise SystemExit('The specification contains private context or workstation paths; review the sources before export.')
    out = REPO / 'docs/specification.html'
    out.write_text(html)
    print(f'Built {out.relative_to(REPO)} ({len(html):,} characters)', file=sys.stdout)


if __name__ == '__main__':
    main()
