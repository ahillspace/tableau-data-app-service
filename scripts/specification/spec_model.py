#!/usr/bin/env python3
"""Derive the offline view's structured model from the current specification documents.

Every descriptive value is read from a document listed in specification.json, so the view cannot
drift from the sources. The one curated input is diagram.json, which holds only presentation: where
each system map card sits, its short card label, edge routes, and the text patterns that place a flow
step on the map. Every card is checked against the documents in both directions. A document or
layout whose shape no longer matches raises an error naming the file and what was expected.
"""
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
LAYOUT = Path(__file__).resolve().parent / 'diagram.json'


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


def bullets(text):
    return [plain(p) for p in re.findall(r'^- (.*?)(?=^- |\Z)', text, re.M | re.S)]


def product(text):
    capabilities = [{'group': group, 'points': bullets(body)}
                    for group, body in subsections(section(text, 'What it does'), 3)]
    if not capabilities:
        raise ShapeError('no groups under "What it does"')
    journeys = [{'name': plain(r['Journey']), 'text': plain(r['What happens'])} for r in tables(section(text, 'Viewer and operator journeys'))[0]]
    exclusions = bullets(section(text, 'Not included'))
    audience = [{'who': who, 'text': plain(rest)} for who, rest in
                re.findall(r'^- \*\*([^*]+)\*\* (.*?)(?=^- |\Z)', section(text, 'Who uses it'), re.M | re.S)]
    if not audience:
        raise ShapeError('expected "- **Who** ..." bullets under "Who uses it"')
    return {'audience': audience, 'capabilities': capabilities, 'journeys': journeys, 'exclusions': exclusions}


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
    topology_text = section(text, 'Topology')
    topology = re.search(r'```text\n(.*?)```', topology_text, re.S)
    return {'components': components, 'trust': trust, 'roles': roles, 'dependencies': dependencies,
            'direction': direction, 'graph': dependency_graph(direction, [c['name'] for c in components]),
            'topology': topology.group(1) if topology else '',
            'notes': prose_lines(re.sub(r'```.*?```', '', topology_text, flags=re.S)),
            'trustNotes': prose_lines(section(text, 'Trust boundaries'))}


def prose_lines(text):
    """Plain prose lines, leaving out tables and lines that point at a file this view does not embed (an image)."""
    return [plain(line) for line in text.splitlines()
            if line.strip() and not line.startswith(('|', 'See [')) and not re.search(r'\]\((?![^)]*\.md(?:#[^)]*)?\))[^)#][^)]*\)', line)]


def dependency_graph(direction, components):
    """Who depends on whom, read from the "Dependency direction" sentences.

    A sentence naming components before "depend(s) on" and after it adds those edges; "every
    component" means every component listed above the subject, as the component order defines.
    """
    names = components + ['Catalog']
    lower = {n.lower(): n for n in names}
    found = lambda part: [lower[k] for k in sorted(lower, key=lambda k: part.lower().find(k))
                          if re.search(rf'\b{re.escape(k)}\b', part.lower())]
    graph = {n: [] for n in names}
    # Catalog templates are data validated by Connections; the direction sentences name that boundary.
    for sentence in direction:
        match = re.search(r'\bdepends? (?:only )?on\b', sentence)
        if not match:
            continue
        subjects = found(sentence[:match.start()])
        rest = sentence[match.end():].split(',')[0]
        targets = found(rest)
        if not subjects:
            raise ShapeError(f'"Dependency direction" names no component before "depends on": {sentence}')
        for subject in subjects:
            if 'every component' in rest:
                targets = components[:components.index(subject)]
            if not targets and not re.search(r'provider type interface', rest):
                raise ShapeError(f'"Dependency direction" names no component after "depends on": {sentence}')
            graph[subject] += [t for t in targets if t != subject and t not in graph[subject]]
    return graph


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


def catalog(text):
    intro = prose_lines(text.split('\n## ', 1)[0].split('\n', 1)[1])
    fields = [{'field': plain(r['Field']), 'does': plain(r['Does'])}
              for r in tables(section(text, 'Template fields'))[0]]
    templates = [{'name': name, 'points': bullets(body)}
                 for name, body in subsections(section(text, 'Templates'), 3)]
    if not fields or not templates:
        raise ShapeError('expected a field table under "Template fields" and entries under "Templates"')
    return {'intro': intro, 'fields': fields, 'templates': templates}


def operations(text):
    stores = [{'store': plain(r['Store']), 'holds': plain(r['Holds']), 'required': plain(r['Required'])}
              for r in tables(section(text, 'Stores'))[0]]
    if not stores:
        raise ShapeError('no stores under "Stores"')
    return {'stores': stores}


def verification(text):
    intro = prose_lines(section(text, 'Automated tests').split('\n|', 1)[0])
    checks = [{'id': plain(r['Check']), 'shows': plain(r['Shows']), 'tests': plain(r['Tests'])}
              for r in tables(section(text, 'Automated tests'))[0]]
    if not checks:
        raise ShapeError('no checks under "Automated tests"')
    gates = [{'id': plain(r['Gate']), 'evidence': plain(r['Required evidence']), 'state': plain(r['State'])}
             for r in tables(section(text, 'Provider intake and console gates'))[0]]
    if not gates:
        raise ShapeError('no gates under "Provider intake and console gates"')
    unverified = section(text, 'Not verified live')
    return {'intro': intro, 'checks': checks, 'gates': gates, 'unverifiedIntro': ' '.join(prose_lines(unverified.split('\n- ', 1)[0])),
            'unverified': bullets(unverified),
            'limitations': bullets(section(text, 'Known limitations'))}


PARSERS = {'docs/product.md': ('product', product), 'docs/architecture.md': ('architecture', architecture),
           'docs/presets.md': ('catalog', catalog), 'docs/operations.md': ('operations', operations),
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
    try:
        model['system'] = system_map(json.loads(LAYOUT.read_text()), model)
        trace_flows(model)
    except ShapeError as error:
        raise ShapeError(f'{LAYOUT.relative_to(REPO)}: {error}') from None
    return model


ROUTE_TOKEN = re.compile(r'(?:\b(GET|POST|PUT|PATCH|DELETE|ANY)\s+)?(?<![\w"./])(/[\w{}./:-]*[\w}])')


def route_patterns(wire):
    """Each documented method and path template in one API table cell, as (methods, regex)."""
    result = []
    for methods, path in re.findall(r'((?:(?:GET|POST|PUT|PATCH|DELETE|ANY),?\s+)+)(/\S+?)(?=\s|$)', wire):
        template = re.escape(path.split('?')[0])
        template = re.sub(r'\\\{path\\\}$', '.+', template)
        template = re.sub(r'\\\{[^}]+\\\}', '[^/]+', template)
        result.append((set(re.findall(r'GET|POST|PUT|PATCH|DELETE|ANY', methods)), re.compile(f'^{template}$')))
    return result


def system_map(layout, model):
    """Join the curated layout to the documents and check that the two describe the same system."""
    arch = model['architecture']
    components = {c['name']: c for c in arch['components']}
    roles = {r['role']: r for r in arch['roles']}
    trust = {t['boundary']: t for t in arch['trust']}
    stores = {s['store']: s for s in model['operations']['stores']}
    docs = {d['path'] for d in model['sources']}
    order = list(components)
    graph = arch['graph']
    called_by = {name: [other for other, deps in graph.items() if name in deps] for name in graph}
    nodes, seen = [], {'component': set(), 'role': set(), 'trust': set(), 'store': set()}
    ids = set()
    for raw in layout.get('nodes', []):
        node = dict(raw)
        where = f'node "{node.get("id", "?")}"'
        for key in ('id', 'x', 'y', 'w', 'h'):
            if key not in node:
                raise ShapeError(f'{where} has no "{key}"')
        if node['id'] in ids:
            raise ShapeError(f'{where} appears twice')
        ids.add(node['id'])
        facts = []
        if 'component' in node:
            name = node['component']
            if name not in components:
                raise ShapeError(f'{where} names component "{name}", which docs/architecture.md does not have; '
                                 f'its components are {", ".join(order)}')
            seen['component'].add(name)
            c = components[name]
            node.update(name=name, kind=f'COMPONENT {order.index(name) + 1:02}', category='component', detail=c['detail'],
                        dependsOn=graph[name], calledBy=called_by[name])
            facts += [('Owns', c['owns']), ('Interface', c['interface']), ('Invariants', c['invariants']),
                      ('Failure and recovery', c['failure']), ('Extension path', c['extension'])]
        elif node.get('catalog'):
            p = model['catalog']
            node.update(name=node.get('title', 'Catalog'), category='catalog', detail='docs/presets.md',
                        dependsOn=graph['Catalog'], calledBy=called_by['Catalog'])
            facts += [('What a template is', ' '.join(p['intro'])),
                      ('Template fields', '; '.join(f"{h['field']}: {h['does']}" for h in p['fields'])),
                      ('Catalog entries', ', '.join(i['name'] for i in p['templates']))]
        elif 'role' in node and 'title' not in node:
            name = node['role']
            if name not in roles:
                raise ShapeError(f'{where} names role "{name}", which docs/architecture.md does not have')
            seen['role'].add(name)
            node.update(name=name, kind='ROLE', category='role')
            facts += [('Runs', roles[name]['runs']), ('Scales', roles[name]['scales'])]
        else:
            if not node.get('title') or not node.get('kind'):
                raise ShapeError(f'{where} is neither a documented component nor a role, so it needs "title" and "kind"')
            node.update(name=node['title'], category='optional' if node.get('optional') else 'external')
            if 'role' in node:
                name = node['role']
                if name not in roles:
                    raise ShapeError(f'{where} names role "{name}", which docs/architecture.md does not have')
                seen['role'].add(name)
                facts += [('Runs', roles[name]['runs']), ('Scales', roles[name]['scales'])]
        for key, label in (('trustIn', 'Boundary into the service'), ('trustOut', 'Boundary out of the service')):
            if key in node:
                boundary = node[key]
                if boundary not in trust:
                    raise ShapeError(f'{where} names trust boundary "{boundary}", which docs/architecture.md does not have')
                seen['trust'].add(boundary)
                facts += [(label, boundary), ('What crosses it', trust[boundary]['crosses']),
                          ('What the service relies on', trust[boundary]['relies'])]
        if 'store' in node:
            store = node['store']
            if store not in stores:
                raise ShapeError(f'{where} names store "{store}", which docs/operations.md does not have')
            seen['store'].add(store)
            facts += [('Store', store), ('Holds', stores[store]['holds']), ('Required', stores[store]['required'])]
        if node.get('doc') and node['doc'].split('#')[0] not in docs:
            raise ShapeError(f'{where} links {node["doc"]}, which specification.json does not list')
        for pattern in node.get('match', []) + node.get('callerMatch', []):
            re.compile(pattern)
        node['facts'] = [{'label': k, 'text': v} for k, v in facts if v]
        nodes.append(node)
    for kind, documented, source in (('component', components, 'docs/architecture.md'), ('role', roles, 'docs/architecture.md'),
                                     ('trust', trust, 'docs/architecture.md'), ('store', stores, 'docs/operations.md')):
        missing = [name for name in documented if name not in seen[kind]]
        if missing:
            raise ShapeError(f'no node shows {source} {kind} {", ".join(missing)}')
    if layout.get('gateway') not in ids:
        raise ShapeError('"gateway" must name a node')
    edges = []
    for edge in layout.get('edges', []):
        if edge.get('from') not in ids or edge.get('to') not in ids or 'path' not in edge:
            raise ShapeError(f'edge {edge.get("from")} -> {edge.get("to")} needs two known nodes and a path')
        edges.append(edge)
    return {key: layout[key] for key in ('width', 'height', 'gateway', 'lanes', 'groups', 'labels')} | {'nodes': nodes, 'edges': edges}


def trace_flows(model):
    """Place every flow step on the system map: its owners, what it names, and the path between them.

    Owners come from the step's "(Owner)" in docs/flows.md and must each be a node. The layout's text
    patterns add the clients, providers and stores a step names. A client ("caller", or a "callerMatch"
    pattern) starts the step and reaches the service through the gateway unless it calls "direct"; the
    owners act in order; anything else named is reached from the last owner, through its "via" node
    when it has one. A step whose owners are all clients stays on the client side.
    """
    system = model['system']
    nodes = {n['id']: n for n in system['nodes']}
    by_name = {}
    for n in system['nodes']:
        for name in [n['name']] + n.get('aliases', []):
            by_name[name] = n['id']
    gateway = system['gateway']
    routes = [(i, route_patterns(r['route'])) for i, r in enumerate(model['api']['routes'])]
    for flow in model['flows']:
        for number, step in enumerate(flow['steps'], 1):
            text = step['text']
            owners = []
            for owner in step['owners']:
                if owner not in by_name:
                    raise ShapeError(f'flow "{flow["name"]}" step {number} is owned by "{owner}", which no node shows')
                owners.append(by_name[owner])
            matched = lambda key: [n['id'] for n in system['nodes'] if any(re.search(p, text) for p in n.get(key, []))]
            callers = [i for i in matched('callerMatch')]
            callers += [i for i in matched('match') if nodes[i].get('caller') and i not in callers]
            named = [i for i in matched('match') if i not in callers and i not in owners]
            local = all(nodes[o].get('caller') for o in owners)
            path = []
            add = lambda a, b: (a != b and [a, b] not in path) and path.append([a, b])
            acting = [o for o in owners if not nodes[o].get('caller') and nodes[o]['category'] in ('component', 'catalog')]
            first = acting[0] if acting else (owners[0] if owners else None)
            if local:
                for c in callers:
                    add(c, first)
            else:
                via_gateway = [c for c in callers if nodes[c].get('caller', 'gateway') == 'gateway']
                for c in callers:
                    add(c, gateway if c in via_gateway else first)
                if via_gateway or re.search(r'(?:^|\s)/[a-z]', text):
                    add(gateway, first)
                for a, b in zip(acting, acting[1:]):
                    add(a, b)
                last = acting[-1] if acting else first
                for target in [o for o in owners if o not in acting] + named:
                    if nodes[target]['category'] == 'role':
                        continue
                    via = nodes[target].get('via')
                    source = next((e['from'] for e in system['edges'] if e['to'] == target and e['from'] in acting), via or last)
                    if via and via != last:
                        add(last, via)
                    add(source, target)
            step['nodes'] = list(dict.fromkeys(callers + owners + named + [x for pair in path for x in pair]))
            step['path'] = path
            step['routes'] = []
            for method, wire in ROUTE_TOKEN.findall(text):
                for index, patterns in routes:
                    if index not in step['routes'] and any((not method or method in ms or 'ANY' in ms) and rx.match(wire)
                                                           for ms, rx in patterns):
                        step['routes'].append(index)
