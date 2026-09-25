#!/usr/bin/env python3
"""Verify content, navigation and text bounds after rendering and visual review."""
from pathlib import Path
from hashlib import sha256
import argparse,json,re
from pypdf import PdfReader
import pdfplumber
P=argparse.ArgumentParser();P.add_argument('pdf',type=Path);a=P.parse_args();HERE=Path(__file__).resolve().parent
services=json.loads((HERE/'services.json').read_text());r=PdfReader(a.pdf)
norm=lambda s:re.sub('[^a-z0-9]','',s.lower())
texts=[norm(p.extract_text() or '') for p in r.pages];full=''.join(texts)
missing=[s['name'] for s in services if norm(s['name']) not in ''.join(texts[3:18])]
terms=['5 sessions / month','15 sessions / month','Always on, tuned to your industry','One session per visitor','roughly 30 seconds','retainer','Majority recommendation','Dissent','Risks','Next steps','scope, price and timeline in writing','Most projects begin with a deposit','service trades','advertising exchanges','combined arrangements','agreed schedule','milestones for larger projects','Monthly reports, quarterly reviews','douglas@legacyai.space']
missing_terms=[x for x in terms if norm(x) not in full]
links=[];internal=[]
for pg in r.pages:
 for ref in pg.get('/Annots',[]):
  d=ref.get_object()
  if '/A' in d:links.append(str(d['/A'].get('/URI','')))
  if '/Dest' in d:internal.append(d['/Dest'])
base='https://legacyai.space';routes=[x for x in links if x.startswith(base+'/')]
wrong_routes=[x for x in links if x.startswith('http') and not x.startswith(base)]
service_links=[x for x in routes if '/solutions/#' in x]
overs=[];used_fonts=set()
with pdfplumber.open(a.pdf) as p:
 for i,pg in enumerate(p.pages):
  for ch in pg.chars:
   if ch['text'].strip():
    used_fonts.add(ch['fontname'])
    if ch['x0']<45 or ch['x1']>568 or ch['top']<30 or ch['bottom']>777:overs.append([i+1,ch['text'],ch['x0'],ch['x1'],ch['top'],ch['bottom']])
report=dict(pages=len(r.pages),services=len(services),missing_services=missing,missing_terms=missing_terms,external_links=len(links),functional_route_links=len(routes),service_links=len(service_links),internal_links=len(internal),wrong_route_domains=wrong_routes,text_outside_safe_bounds=overs,used_fonts=sorted(used_fonts),bytes=a.pdf.stat().st_size,sha256=sha256(a.pdf.read_bytes()).hexdigest())
assert len(r.pages)==23 and len(service_links)==54 and len(routes)==57
assert not missing and not missing_terms and not overs and not wrong_routes,report
(HERE/'verification.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
