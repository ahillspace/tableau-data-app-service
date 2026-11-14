#!/usr/bin/env python3
"""Refresh presentation excerpts from architecture-owned planning documents."""
import json
import re
from pathlib import Path
ROOT=Path(__file__).resolve().parent
REPO=ROOT.parent.parent

def plain(text):
    text=re.sub(r'\[([^]]+)\]\([^)]+\)',r'\1',text)
    return re.sub(r'\s+',' ',text.replace('**','').replace('`','')).strip()

def enrich(model):
    module_text=(REPO/'planning/module-design.md').read_text()
    modules=[]
    for match in re.finditer(r'^### (M\d+) - ([^\n]+)\n(.*?)(?=^### |^## |\Z)',module_text,re.M|re.S):
        mid,title,body=match.groups()
        fields={k.lower():plain(v) for k,v in re.findall(r'^\*\*([^*]+):\*\* (.*?)(?=^\*\*|\Z)',body,re.M|re.S)}
        modules.append(dict(id=mid,name=title,owner=mid+' / '+title,status='Proposed',source='modules',responsibility=fields.get('owns',''),interfaces=fields.get('interfaces',''),invariant=fields.get('invariant',''),failure=fields.get('failure/recovery',''),extension=fields.get('extension',''),input=fields.get('input',''),output=fields.get('output',''),state=fields.get('state',''),holds=fields.get('holds',''),decisions=sorted(set(re.findall(r'D\d\d',fields.get('holds',''))))))
    aliases={'SDK':'M10','HTTP':'M08','Access':'M01','Connections':'M02','Transport':'M05','Jobs':'M06','Events':'M07','Credentials':'M03','Providers':'M04','Persistence':'M09'}
    dependencies=[]
    for line in module_text.splitlines():
        edge=re.match(r'\s*(\w+)(?:\[[^]]+\])? --> (\w+)',line)
        if edge and all(alias in aliases for alias in edge.groups()):dependencies.append(tuple(aliases[a] for a in edge.groups()))
    for module in modules:
        module['dependsOn']=[b for a,b in dependencies if a==module['id']]
        module['calledBy']=[a for a,b in dependencies if b==module['id']]
    model['modules']=modules
    text=(REPO/'planning/decision-register.md').read_text()
    status_rows = {}
    for line in text.splitlines():
        if re.match(r'\| D\d\d ', line):
            columns = [plain(c) for c in line.strip().strip('|').split('|')]
            status_rows[columns[0]] = columns
    decisions=[]
    for match in re.finditer(r'^## (D\d+) - ([^\n]+)\n(.*?)(?=^## |\Z)',text,re.M|re.S):
        did,title,body=match.groups()
        row=status_rows[did]
        summary=re.search(r'^\*\*Policy summary:\*\* (.+)$',body,re.M)
        if not summary: raise ValueError(f'{did}: missing canonical policy summary')
        decisions.append(dict(id=did,owner=row[1],question=row[1],context=row[3],recommendation=plain(summary.group(1)),engineering=row[4],status='Accepted',source='decisions'))
    model['decisions']=decisions
    model['sources']=json.loads((REPO/'specification.json').read_text())['documents']
    for c in model['components']:c['source']='system'
    system_text=(REPO/'planning/system-design.md').read_text()
    trust_section=system_text.split('## Trust and data classification')[1].split('## Logical state model')[0]
    model['classifications']=[[plain(c) for c in line.strip().strip('|').split('|')] for line in trust_section.splitlines() if line.startswith('|')][2:]
    model['systemDecision']='D02'
    api_text=(REPO/'planning/api-design.md').read_text()
    inventory=api_text.split('## Endpoint inventory')[1].split('## Service resource schemas')[0]
    apis=[]
    for line in inventory.splitlines():
        if not re.match(r'\| A\d\d ',line):continue
        aid,wire,caller,io,owner,hold=[plain(c) for c in line.strip().strip('|').split('|')]
        unset='intentionally unset' in wire
        path_match=re.search(r'(/(?:v1|health)/\S+)',wire)
        route=path_match.group(1) if path_match else wire
        method=wire[:wire.index(route)].strip() if path_match else 'Unset'
        family=('Identity' if int(aid[1:])<=7 else 'Connections' if int(aid[1:])<=17 or aid=='A36' else 'Native proxy' if aid in ('A18','A37') else 'Capabilities' if aid in ('A19','A39') else 'Jobs' if int(aid[1:])<=24 or aid=='A27' else 'Events' if int(aid[1:])<=26 else 'Site registry' if int(aid[1:])<=33 else 'Operations')
        parts=io.split(' -> ',1)
        apis.append(dict(id=aid,name=aid+' / '+family,family=family,method=method,route=route,caller=caller,authority=('Inert bootstrap/proof binding; no viewer identity assumed.' if 'Unauthenticated' in caller or 'navigation' in caller else 'Distinct registry-management authority.' if 'Registry-management' in caller else 'Verified transaction/source protocol.' if 'callback' in caller.lower() or 'provider source' in caller.lower() else 'Host/network ingress policy.' if 'Host/' in caller else 'Current verified deployment/site/user and resource audience; app IDs are configuration, not identity.'),holds=hold,owner=owner,status='Open' if unset else 'Proposed',request=parts[0],response=parts[1] if len(parts)>1 else io,failure='Declared caller/protocol checks and safe error handling apply. '+hold,source='api',component=owner.split('/')[0],decision=next(iter(re.findall(r'D\d\d',hold)),None)))
    authority_overrides={'A01':'Unauthenticated bootstrap; app/origin does not establish identity.','A02':'Inert service-owned handoff page; locator alone cannot start OAuth.','A03':'Bound initiation proof and browser correlation; no existing app identity assumed.','A04':'Supported identity response, protocol state and browser correlation.','A05':'Single-use initiating proof; no reusable authority in the URL.','A07':'Verified returning-browser binding within the seven-day authentication maximum; cookie plus arbitrary null-origin requester proof is insufficient.','A13':'Inert provider handoff page; locator alone cannot start consent.','A15':'Provider protocol state/code/response and browser correlation.','A26':'Exact provider source verification before routing or acknowledgement.','A27':'Provider source/per-task proof and bound task correlation.'}
    for api in apis:
        if api['id'] in authority_overrides:api['authority']=authority_overrides[api['id']]
    model['apis']=apis
    flow_text=(REPO/'planning/data-flows.md').read_text()
    flows=[]
    for match in re.finditer(r'^## (F\d+) - ([^\n]+)\n(.*?)(?=^## |\Z)',flow_text,re.M|re.S):
        fid,name,body=match.groups()
        presentation=model['flowPresentation'][fid]
        row_count=len(re.findall(r'^\| \d+ ',body,re.M))
        if len(presentation['titles']) != row_count or len(presentation['edges']) != row_count:
            raise ValueError(f'{fid}: curated step count differs from canonical flow')
        steps=[]
        for line in body.splitlines():
            if not re.match(r'\| \d+ ',line):continue
            number,route,data,effect,failure=[plain(c) for c in line.strip().strip('|').split('|')]
            index=int(number)-1
            pairs=presentation['edges'][index]
            steps.append(dict(title=presentation['titles'][index],from_=pairs[0][0],to=pairs[0][1],edges=pairs,route=route,data=data,authority=effect,state=effect,failure=failure,status='Open' if 'OPEN' in effect else 'Proposed',source='flows'))
            steps[-1]['from']=steps[-1].pop('from_')
        status=re.search(r'^Status: (.+)$',body,re.M)
        routes=re.search(r'^Routes?: (.+)$',body,re.M)
        flows.append(dict(id=fid,name=fid+' / '+name,steps=steps,decision=presentation['decision'],statusNote=status.group(1) if status else '',routes=routes.group(1) if routes else '',source='flows'))
    model['flows']=flows
    plan_text=(REPO/'planning/build-plan.md').read_text()
    phases=[]
    for match in re.finditer(r'^## (B\d+) - ([^\n]+)\n(.*?)(?=^## |\Z)',plan_text,re.M|re.S):
        pid,title,body=match.groups()
        fields={k.lower():plain(v) for k,v in re.findall(r'^\*\*([^*]+):\*\* (.*?)(?=^\*\*|^- \[|\Z)',body,re.M|re.S)}
        tasks=[plain(t) for t in re.findall(r'^- \[ \] (.+)$',body,re.M)]
        phases.append(dict(id=pid,title=pid+' / '+title,work=' '.join(tasks),tasks=tasks,gate=fields.get('completion evidence',''),owners=fields.get('owners',''),dependsOn=fields.get('depends on',''),holds=fields.get('holds',''),risk=fields.get('risk',''),source='plan',status='Proposed'))
    model['phases']=phases
    model['planEdges']=re.findall(r'^\s+(B\d+)(?:\[[^]]+\])? --> (B\d+)',plan_text,re.M)
    limits_text=(REPO/'planning/limitations-audit.md').read_text()
    model['limitations']=[[plain(c) for c in line.strip().strip('|').split('|')] for line in limits_text.splitlines() if re.match(r'\| L\d\d ',line)]
    evidence=text.split('## Evidence gates that do not need new product policy')[1].split('## Keep the scope small')[0]
    model['evidence']=[[plain(c) for c in line.strip().strip('|').split('|')] for line in evidence.splitlines() if re.match(r'\| E\d\d ',line)]
    return model
