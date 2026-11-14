#!/usr/bin/env python3
"""Package the editable review sources as one offline-capable Overhead document."""
import json
import hashlib
import subprocess
import re
from pathlib import Path
from planning_model import enrich

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent

def main():
    model = enrich(json.loads((ROOT / 'model.json').read_text()))
    for source in model['sources']:
        path = REPO / source['path']
        source['content'] = path.read_text()
        source['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
    rendered = subprocess.run(['node', str(ROOT / 'render-documents.cjs')], input=json.dumps(model['sources']), text=True, capture_output=True)
    if rendered.returncode:
        raise SystemExit(rendered.stderr)
    model['sources'] = json.loads(rendered.stdout)
    template = (ROOT / 'template.html').read_text()
    html = template.replace('/*__STYLE__*/', (ROOT / 'template.css').read_text())
    html = html.replace('/*__MODEL__*/', json.dumps(model, ensure_ascii=False).replace('</', '<\\/'))
    html = html.replace('/*__SCRIPT__*/', (ROOT / 'template.js').read_text())
    private_context = re.compile(r'/home/|/Users/|[A-Za-z]:\\Users\\|ahillspace|solutions engineering team|Google/Salesforce|Google/staff', re.I)
    if private_context.search(html):
        raise SystemExit('Public specification contains private context or workstation paths; review sources before export.')
    (ROOT / 'architecture-review.html').write_text(html)
    print(f'Built {ROOT / "architecture-review.html"} ({len(html):,} characters)')

if __name__ == '__main__':
    main()
