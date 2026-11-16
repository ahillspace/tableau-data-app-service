#!/usr/bin/env python3
"""Derive the offline view's structured model from the current specification documents.

Every value here is read from a document listed in specification.json; nothing is curated by hand,
so the view cannot drift from the sources. A document whose shape no longer matches raises an
error naming the document and what was expected.
"""
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent


class ShapeError(ValueError):
    pass


def plain(text):
    """Markdown inline text to plain text."""
    text = re.sub(r'\[([^]]+)\]\([^)]+\)', r'\1', text)
    return re.sub(r'\s+', ' ', text.replace('**', '').replace('`', '')).strip()


def section(text, heading, level=2):
    """The body under one heading, up to the next heading of the same or higher level."""
    marks = '#' * level
    match = re.search(rf'^{marks} {re.escape(heading)}\n(.*?)(?=^#{{1,{level}}} |\Z)', text, re.M | re.S)
    if not match:
        raise ShapeError(f'missing section "{heading}"')
    return match.group(1)


def subsections(text, level):
    marks = '#' * level
    return [(m.group(1).strip(), m.group(2)) for m in
            re.finditer(rf'^{marks} ([^\n]+)\n(.*?)(?=^#{{1,{level}}} |\Z)', text, re.M | re.S)]


def tables(text):
    """Every Markdown table in text as a list of row dicts keyed by plain header text."""
    result = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        if lines[i].startswith('|') and i + 1 < len(lines) and re.match(r'^\|\s*-', lines[i + 1]):
            header = [plain(c) for c in lines[i].strip().strip('|').split('|')]
            rows = []
            i += 2
            while i < len(lines) and lines[i].startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                rows.append({h: c for h, c in zip(header, cells)})
                i += 1
            result.append(rows)
        else:
            i += 1
    return result


def items(text, pattern):
    """Bulleted items whose text starts with an ID like R12 or A3, with continuation lines."""
    found = []
    for match in re.finditer(rf'^- ({pattern})\. (.*?)(?=^- |^#|^\n|\Z)', text, re.M | re.S):
        found.append({'id': match.group(1), 'text': plain(match.group(2))})
    return found


def product(text):
    requirements = []
    for group, body in subsections(section(text, 'Requirements'), 3):
        for item in items(body, r'R\d+'):
            requirements.append({**item, 'group': group})
    if not requirements:
        raise ShapeError('no requirements R1..Rn under "Requirements"')
    recommendations = [{'group': group, 'points': [plain(p) for p in re.findall(r'^- (.*?)(?=^- |\Z)', body, re.M | re.S)]}
                       for group, body in subsections(section(text, 'Recommendations'), 3)]
    assumptions = items(section(text, 'Unverified assumptions'), r'A\d+')
    journeys = [{'name': plain(r['Journey']), 'text': plain(r['What happens'])} for r in tables(section(text, 'Viewer and operator journeys'))[0]]
    exclusions = [plain(p) for p in re.findall(r'^- (.*?)(?=^- |\Z)', section(text, 'Exclusions'), re.M | re.S)]
    status = {k.lower().replace(' ', '-'): plain(v) for k, v in re.findall(r'^(Design status|Implementation status|User acceptance): (.+)$', text, re.M)}
    return {'requirements': requirements, 'recommendations': recommendations, 'assumptions': assumptions,
            'journeys': journeys, 'exclusions': exclusions, 'status': status}


def architecture(text):
    components = []
    for name, body in subsections(section(text, 'Components'), 3):
        fields = {k.lower(): plain(v) for k, v in re.findall(r'^- \*\*([^*]+):\*\* (.*?)(?=^- \*\*|\Z)', body, re.M | re.S)}
        detail = re.search(r'\*\*Detail:\*\* \[[^]]+\]\(([\w-]+)\.md', body)
        components.append({'name': name, 'owns': fields.get('owns', ''), 'interface': fields.get('interface', ''),
                           'invariants': fields.get('invariants', ''), 'failure': fields.get('failure', ''),
                           'extension': fields.get('extension', ''), 'detail': f'docs/{detail.group(1)}.md' if detail else None})
    if not components:
        raise ShapeError('no components under "Components"')
    trust = [{'boundary': plain(r['Boundary']), 'crosses': plain(r['What crosses it']), 'relies': plain(r['What the service relies on'])}
             for r in tables(section(text, 'Trust boundaries'))[0]]
    roles = [{'role': plain(r['Role']), 'runs': plain(r['Runs']), 'scales': plain(r['Scales'])} for r in tables(section(text, 'Roles'))[0]]
    dependencies = [{'package': plain(r['Package']), 'usedBy': plain(r['Used by']), 'job': plain(r['Job'])} for r in tables(section(text, 'Dependencies'))[0]]
    direction = [plain(line) for line in section(text, 'Dependency direction').splitlines() if line.strip()]
    topology = re.search(r'```text\n(.*?)```', section(text, 'Topology'), re.S)
    return {'components': components, 'trust': trust, 'roles': roles, 'dependencies': dependencies,
            'direction': direction, 'topology': topology.group(1) if topology else ''}


def api(text):
    routes = []
    notes = {}
    for group, body in subsections(text, 2):
        intro = [plain(line) for line in body.split('\n|', 1)[0].splitlines() if line.strip()]
        if intro:
            notes[group] = ' '.join(intro)
        for table in tables(body):
            for row in table:
                key = 'Method and path' if 'Method and path' in row else None
                if not key:
                    continue
                wire = plain(row[key])
                routes.append({'group': group, 'route': wire, 'auth': plain(row.get('Auth', '')),
                               'owner': plain(row.get('Owner', '')), 'purpose': plain(row.get('Purpose', ''))})
    if not routes:
        raise ShapeError('no route tables with a "Method and path" column')
    preamble = ' '.join(plain(line) for line in text.split('\n## ', 1)[0].splitlines()[1:] if line.strip())
    return {'preamble': preamble, 'notes': notes, 'routes': routes}


def flows(text):
    result = []
    for name, body in subsections(text, 2):
        steps = []
        for match in re.finditer(r'^\d+\. (.*?)(?=^\d+\. |^\n|\Z)', body, re.M | re.S):
            step = plain(match.group(1))
            owner = re.search(r'\(([^()]+)\)\.?$', step)
            steps.append({'text': re.sub(r'\s*\([^()]+\)\.?$', '.', step) if owner else step,
                          'owners': [o.strip() for o in owner.group(1).split(',')] if owner else []})
        see = re.search(r'^See \[[^]]+\]\(([\w-]+)\.md(?:#([\w-]+))?\)', body, re.M)
        if steps:
            result.append({'name': name, 'steps': steps, 'see': f'docs/{see.group(1)}.md' if see else None})
    if not result:
        raise ShapeError('no numbered flows')
    return result


def verification(text):
    def gates(heading):
        rows = tables(section(text, heading))[0]
        return [{'id': plain(r['Gate']), 'shows': plain(r['Shows']), 'status': plain(r['Status']),
                 'evidence': plain(r.get('Evidence', ''))} for r in rows]
    limitations = [plain(p) for p in re.findall(r'^- (.*?)(?=^- |\Z)', section(text, 'Known limitations'), re.M | re.S)]
    return {'automated': gates('Automated gates'), 'live': gates('Live gates'), 'limitations': limitations}


PARSERS = {'docs/product.md': ('product', product), 'docs/architecture.md': ('architecture', architecture),
           'docs/api.md': ('api', api), 'docs/flows.md': ('flows', flows), 'docs/verification.md': ('verification', verification)}


def build_model():
    documents = json.loads((REPO / 'specification.json').read_text())['documents']
    model = {'sources': documents}
    paths = {d['path'] for d in documents}
    for path, (key, parse) in PARSERS.items():
        if path not in paths:
            raise ShapeError(f'specification.json must list {path}')
        try:
            model[key] = parse((REPO / path).read_text())
        except ShapeError as error:
            raise ShapeError(f'{path}: {error}') from None
    return model
