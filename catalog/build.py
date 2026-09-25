#!/usr/bin/env python3
"""Build the illustrated Legacy AI field guide. See README.md for dependencies."""
from pathlib import Path
from html import escape
from hashlib import sha256
import argparse,json,re
from reportlab.pdfgen import canvas
from reportlab.lib import colors
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from editorial import CHAPTERS,ROUTES,INDUSTRIES
P=argparse.ArgumentParser();P.add_argument('--output',required=True,type=Path);a=P.parse_args()
HERE=Path(__file__).resolve().parent;ASSETS=HERE/'assets';OUT=a.output.resolve();OUT.parent.mkdir(parents=True,exist_ok=True)
SERVICES=json.loads((HERE/'services.json').read_text())
BASE='https://legacyai.space'
for name,path in [('Serif','SourceSerif4-Regular.ttf'),('Sans','Inter-Regular.ttf'),('SansBold','Inter-Semibold.ttf')]:pdfmetrics.registerFont(TTFont(name,str(ASSETS/path)))
pdfmetrics.registerFontFamily('Sans',normal='Sans',bold='SansBold',italic='Sans',boldItalic='SansBold')
pdfmetrics.registerFontFamily('Serif',normal='Serif',bold='Serif',italic='Serif',boldItalic='Serif')
W,H=612,792;M=46;CW=W-2*M;COL=244;GAP=32
BLUE='#203744';CREAM='#F5F1E8';COPPER='#B86C42';FOREST='#315344';PALE='#E3E9E8';INK='#21313B';MUTED='#52636A';RULE='#C8CBC5';WHITE='#FFFCF6'
C=canvas.Canvas(str(OUT),pagesize=(W,H),pageCompression=1)
C.setTitle("A better day's work. | Legacy AI Field Guide");C.setAuthor('Legacy AI Solutions');C.setSubject('A practical guide to solutions for owner-operated businesses')
PAGE=0;LOG=[];ART=[];SERVICE_PAGES={}
def col(s):return colors.HexColor(s)
def rect(x,y,w,h,fill):C.setFillColor(col(fill));C.rect(x,H-y-h,w,h,fill=1,stroke=0)
def line(x,y,x2,y2,fill=RULE,lw=.6):C.setStrokeColor(col(fill));C.setLineWidth(lw);C.line(x,H-y,x2,H-y2)
def txt(s,x,y,font='Sans',size=10,fill=INK,track=0):
 C.setFillColor(col(fill));t=C.beginText(x,H-y-size);t.setFont(font,size);t.setCharSpace(track);t.textOut(s);t.setCharSpace(0);C.drawText(t)
def para(s,x,y,w,font='Sans',size=11,leading=None,fill=INK,maxh=None):
 p=Paragraph(s,ParagraphStyle('p',fontName=font,fontSize=size,leading=leading or size*1.4,textColor=col(fill),allowWidows=0,allowOrphans=0))
 _,h=p.wrap(w,10000)
 if maxh is not None and h>maxh+.1:raise ValueError(f'Page {PAGE}: {h:.1f}>{maxh} {s[:80]}')
 if x<M-.1 or x+w>W-M+.1 or y+h>(775 if y>=750 else 737):raise ValueError(f'Page {PAGE}: outside text bounds: {s[:60]} ({x},{y},{w},{h})')
 p.drawOn(C,x,H-y-h);LOG.append(dict(page=PAGE,text=re.sub('<[^>]+>','',s),x=x,y=y,w=w,h=h));return h
def label(s,x=M,y=91,fill=COPPER):txt(s.upper(),x,y,font='SansBold',size=8,fill=fill,track=1.1)
def external(label,url,x,y,w,size=10.5,fill=BLUE):
 h=para(escape(label),x,y,w,size=size,fill=fill);C.linkURL(url,(x,H-y-h,x+w,H-y),relative=0,thickness=0);return h
def goto(label,target,x,y,w,size=10.5,fill=BLUE):
 h=para(escape(label),x,y,w,size=size,fill=fill);C.linkRect('',target,(x,H-y-h,x+w,H-y),relative=0,thickness=0);return h
def art(name,x,y,w,h):
 if name in ART:raise ValueError('Editorial illustration repeated: '+name)
 ART.append(name)
 im=ImageReader(str(ASSETS/name));iw,ih=im.getSize();scale=max(w/iw,h/ih);dw,dh=iw*scale,ih*scale
 C.saveState();clip=C.beginPath();clip.rect(x,H-y-h,w,h);C.clipPath(clip,stroke=0)
 C.drawImage(im,x+(w-dw)/2,H-y-h+(h-dh)/2,dw,dh);C.restoreState()
def start(section,theme='light',key=None):
 global PAGE
 PAGE+=1;bg=BLUE if theme=='dark' else CREAM;rect(0,0,W,H,bg)
 if key:C.bookmarkPage(key);C.addOutlineEntry(section,key,0,False)
 txt('LEGACY AI',M,32,font='SansBold',size=9,fill=CREAM if theme=='dark' else BLUE,track=1)
 txt('A FIELD GUIDE TO BETTER WORK',219,33,size=7.5,fill=CREAM if theme=='dark' else MUTED,track=.4)
 line(M,57,W-M,57,fill=COPPER if theme=='dark' else RULE)
def end(section,theme='light'):
 dark=theme=='dark';ink=CREAM if dark else BLUE
 line(M,750,W-M,750,fill=COPPER if dark else RULE)
 txt(f'{PAGE:02d}',M,757,font='SansBold',size=11,fill=COPPER)
 txt(section.upper(),M+31,761,size=7,fill=ink,track=.6)
 C.linkURL('https://legacyai.space',(459,18,566,38),relative=0,thickness=0)
 txt('legacyai.space',472,760,size=8,fill=ink)
 C.showPage()
def title(s,y=109,size=34,w=CW,fill=BLUE):return para(s.replace('\n','<br/>'),M,y,w,font='Serif',size=size,leading=size*1.14,fill=fill,maxh=150)
def rule_note(heading,body,y=638):
 line(M,y,W-M,y,COPPER,1.2);label(heading,y=y+14);para(escape(body),M,y+35,CW,size=10.2,leading=14.5,fill=MUTED,maxh=71)
def service(it,number,x,y,w,maxh=160):
 label(f'{number:02d} / '+it['tag'].replace('→','/'),x,y)
 nh=para(escape(it['name']),x,y+20,w,font='Serif',size=18.4,leading=21.4,maxh=66)
 bh=para(escape(it['body']),x,y+29+nh,w,size=10.35,leading=14.5,maxh=maxh-35-nh)
 C.linkURL(BASE+'/solutions/#'+it['id'],(x,H-y-maxh,x+w,H-y),relative=0,thickness=0)
 SERVICE_PAGES[it['name']]=PAGE
 return 29+nh+bh

# 1. Cover: book identity, no website slogan or site photography.
start('Cover',theme='dark',key='cover')
label('The 2026 field guide',y=83,fill='#DAB496')
title("A better<br/>day's work.",y=115,size=56,fill=CREAM)
para('The Legacy AI guide to getting more done.',M,263,CW,font='Sans',size=16.2,leading=22,fill=CREAM,maxh=50)
art('cover-town.jpg',M,326,CW,347)
line(M,699,M+72,699,COPPER,3)
para('Practical solutions for the work behind the work.',M+91,688,CW-91,size=11.3,leading=16,fill=CREAM,maxh=36)
end('Legacy AI Solutions','dark')

# 2. Contents framed as routes through the guide.
start('Find your starting point',key='contents');label('Navigation');title('Open where the work<br/>gets stuck.',size=35)
para('This is a working guide, not a package to buy all at once. Find the situation that sounds familiar, read the relevant options, and bring one useful question to the conversation.',M,210,CW,size=11.3,leading=16,maxh=64)
external('Prefer a guided start? Use the online intake.',BASE+'/intake/',M,267,CW,size=9.5,fill=FOREST)
y=294
for i,(problem,detail,name,pageno) in enumerate(ROUTES):
 line(M,y,W-M,y)
 txt(f'{pageno:02d}',M,y+13,font='SansBold',size=16,fill=COPPER)
 para(escape(problem),M+44,y+9,CW-44,font='Serif',size=19.5,leading=23,maxh=26)
 para(escape(detail),M+44,y+38,CW-44,size=9.5,leading=13,fill=MUTED,maxh=28)
 C.linkRect('',f'ch-{i+1}' if i<5 else 'board',(M,H-y-65,W-M,H-y),relative=0,thickness=0)
 y+=69
para('Also inside: working together · 20   Industries · 21   Connected workflows · 22   Your project brief · 23',M,717,CW,size=8.4,leading=12,fill=MUTED,maxh=15)
end('Find your starting point')

# 3. New editorial decision aid.
start('Choose one useful change',key='choose');label('Before you choose');title('Make the first change<br/>small enough to see.',size=35)
para('The strongest starting point is usually a specific piece of work that repeats. Describe it plainly before choosing the tool. Use these four questions to turn a general frustration into a workable brief.',M,211,CW,size=11.4,leading=16,maxh=65)
qs=[('What happens?','Choose an ordinary example: a call goes unanswered, a report waits for notes, or a customer asks for the same update.'),('Where does it wait?','Name the moment the process slows down. It may be a handoff, a missing detail, a repeated entry or a decision only you can make.'),('What should happen next?','Describe the useful next step in everyday language: book a time, produce a report, collect approval or alert the right person.'),('How will you recognize done?','Use a real example to agree on what you will see working. Keep the first conversation grounded in your workflow and your customers.')]
y=313
for i,(h,b) in enumerate(qs):
 rect(M,y,31,31,COPPER);txt(str(i+1),M+10,y+6,font='SansBold',size=13,fill=WHITE)
 para(escape(h),M+49,y-1,CW-49,font='Serif',size=21,leading=24,maxh=28)
 para(escape(b),M+49,y+32,CW-49,size=10.6,leading=15,maxh=48)
 y+=99
end('Choose one useful change')

# 4-18. Three pages per chapter: illustrated selection guide and two reference pages.
for ci,ch in enumerate(CHAPTERS):
 start(ch['name'],key=f'ch-{ci+1}');label(ch['code']+' / '+ch['name']);title(ch['title'],size=31)
 para(escape(ch['intro']),M,193,CW,size=11,leading=15.5,maxh=64)
 art(ch['image'],M,257,CW,320)
 label('How to choose',y=596)
 para(escape(ch['choose']),M,618,CW,font='Serif',size=22,leading=26,maxh=55)
 para(escape(ch['guidance']),M,656,CW,size=10.5,leading=15,maxh=60)
 goto('Explore the options on the next two pages.',f'ch-{ci+1}-services',M,722,CW,size=9.3,fill=FOREST)
 end(ch['name'])
 group=SERVICES[ch['start']:ch['start']+ch['count']]
 first=(ch['count']+1)//2
 splits=[group[:first],group[first:]]
 for gi,items in enumerate(splits):
  start(ch['name'],key=f'ch-{ci+1}-services' if gi==0 else None)
  label(ch['code']+' / '+ch['name']);title(ch['groups'][gi],size=29)
  line(M,190,W-M,190,COPPER,1.1)
  for n,it in enumerate(items):
   x=M+(n%2)*(COL+GAP);y=212+(n//2)*172
   service(it,ch['start']+(0 if gi==0 else first)+n+1,x,y,COL,maxh=166)
  if len(items)==5:
   x=M+COL+GAP;y=538
   line(x,y,x+COL,y,COPPER,1.2)
   label('A useful question',x,y+13)
   para(escape(ch['question']),x,y+37,COL,font='Serif',size=19,leading=24,maxh=85)
  if len(items)<5:rule_note('Bring this to the conversation',ch['notes'][gi],y=620)
  end(ch['name'])

# 19. A distinct decision worksheet instead of the website's Board interface.
start('The Board',theme='dark',key='board');label('A place to test the decision',fill='#DAB496');title('Borrow another<br/>point of view.',size=37,fill=CREAM)
para('Bring a decision with real consequences: hiring, pricing, an acquisition or a change of direction. Five senior advisors debate the issue and return a report you can use to think it through.',M,218,CW,size=11.3,leading=16.2,fill=CREAM,maxh=69)
line(M,311,W-M,311,COPPER,1)
label('What comes back',y=330,fill='#DAB496')
for i,(h,b) in enumerate([('Majority recommendation','The direction the advisors favor.'),('Dissent','The strongest competing perspective.'),('Risks','The concerns to weigh before acting.'),('Next steps','A practical route beyond the question.')]):
 x=M+(i%2)*276;y=357+(i//2)*79
 para(h,x,y,COL,font='Serif',size=19,leading=23,fill=CREAM,maxh=26)
 para(b,x,y+32,COL,size=10,leading=14,fill='#D5E0E1',maxh=29)
line(M,521,W-M,521,COPPER,1)
label('Ways to keep a seat',y=540,fill='#DAB496')
seats=[('The Counsel','5 sessions / month'),('The Boardroom','15 sessions / month'),('The Standing Seat','Always on, tuned to your industry')]
for i,(h,b) in enumerate(seats):
 y=565+i*39
 para(h,M,y,230,font='Serif',size=18,leading=21,fill=CREAM,maxh=23)
 para(b,M+244,y+3,276,size=10.3,leading=14,fill=CREAM,maxh=29)
external('Try one free session at the Board',BASE+'/board/',M,695,CW,size=10.5,fill='#E4BA9B')
para('One session per visitor; roughly 30 seconds of deliberation. Ask Douglas about ongoing access on retainer.',M,715,CW,size=8.5,leading=12,fill='#D5E0E1',maxh=25)
end('The Board','dark')

# 20. Current five-step commercial process, fresh supporting prose.
start('Working together',key='deal');label('From a problem to a working solution');title('Agree on the work.<br/>Then put it to use.',size=34)
steps=[('You tell us what\'s broken','30-minute call','Describe the missed calls, lost leads or paperwork using real examples. The first conversation is about the work that needs attention. No pitch.'),('We agree on the plan','Before work begins','We put the scope, price and timeline in writing. Most projects begin with a deposit. For service trades, advertising exchanges or combined arrangements, value and commitments are agreed up front.'),('We build. You see it working.','One session','We configure, customize and test the solution, then walk through it using your branding and workflow. What done looks like is agreed before we start.'),('We go live together','Day one','We launch and help you put the solution to work. Payments follow the agreed schedule, with milestones for larger projects.'),('We keep making it better','Ongoing','Monthly reports, quarterly reviews and ongoing improvements keep the work moving after launch.')]
y=241
for i,(h,t,b) in enumerate(steps):
 txt(f'{i+1:02d}',M,y,font='SansBold',size=20,fill=COPPER)
 hh=para(escape(h),M+43,y,CW-43,font='Serif',size=20,leading=23,maxh=48)
 label(t,M+43,y+hh+7)
 para(escape(b),M+43,y+hh+25,CW-43,size=10.2,leading=14.5,maxh=63)
 y+=109 if i==1 else 96
external('Current details and next steps at legacyai.space/deal',BASE+'/deal/',M,724,CW,size=8.8,fill=FOREST)
end('Working together')

# 21. Concrete industry applications, no copied card design.
start('The work in your industry',key='industries');label('Familiar work, different settings');title('Begin with the job,<br/>not the industry label.',size=32)
para('These are industries Legacy AI already knows. Their workflows are useful starting points; the right arrangement still depends on your customers, your team and how your work gets done.',M,207,CW,size=11,leading=15.5,maxh=65)
for i,(h,b) in enumerate(INDUSTRIES):
 x=M+(i%2)*276;y=305+(i//2)*112
 line(x,y,x+COL,y,COPPER,1)
 hh=para(escape(h),x,y+14,COL,font='Serif',size=18,leading=21,maxh=44)
 para(escape(b),x,y+23+hh,COL,size=10,leading=14,maxh=64-hh+21)
rule_note('When your work is different','Describe the repetitive task. Examples include watching insurance claim portals or permit filings, sorting an inbox and drafting replies, tracking competitor prices, answering DMs, or reordering inventory.',y=649)
end('The work in your industry')

# 22. New editorial combinations; examples of connecting existing offerings.
start('Think in connected steps',key='workflows');label('Combine only what the work needs');title('A useful tool is good.<br/>A clear handoff is better.',size=32)
para('These are starting routes through the existing menu, not new packages. Use them to describe the flow you want, then agree the scope around your actual process.',M,205,CW,size=11,leading=15.5,maxh=65)
flows=[('From an unanswered call to a time on the calendar','The Missed-Call Recovery → The Follow-Up Machine → The Live Booking Calendar','Start with the customer who has already tried to reach you.','01 / pages 5-6'),('From the field to a finished customer record','The Talk-To-Type Field Tool → The Report Writer → The Digital Sign-Off → The Customer Portal','Decide who captures the details, who approves them and where the customer finds the result.','02-03 / pages 8-9, 11'),('From one explanation to a wider conversation','Blog From A Voice Memo → The Social Media Sidekick → Email & Text Campaigns','Choose the source material and the places it should appear.','04 / pages 14-15'),('From scattered tools to a clearer view','Customer List That Actually Works → Make Your Tools Talk → The Owner\'s Dashboard','Identify the record you trust and the connections it needs.','05 / pages 17-18')]
y=288
for h,path,b,ref in flows:
 label(ref,y=y)
 para(escape(h),M,y+21,CW,font='Serif',size=18.6,leading=22,maxh=46)
 para(escape(path).replace('→',' / '),M,y+52,CW,size=10.1,leading=14,fill=FOREST,maxh=29)
 para(escape(b),M,y+85,CW,size=9.5,leading=13,fill=MUTED,maxh=27)
 y+=111
end('Think in connected steps')

# 23. A useful write-in brief and direct contact.
start('Your working brief',key='brief');label('Bring this page to the conversation');title('One page.<br/>A clearer next step.',size=35)
para('Write a few words in each space. A concrete example is more useful than a technical specification.',M,211,CW,size=11.2,leading=16,maxh=50)
fields=[('The piece of work I want to improve','What happens today, and what is frustrating about it?'),('The people and tools involved','Who touches the work? Where does the information live?'),('What I want to see working','Describe the next step or finished result in plain language.'),('The examples I can bring','A report, a typical inquiry, a calendar, a form or an existing process.')]
y=279
for h,b in fields:
 para(h,M,y,CW,font='Serif',size=18,leading=22,maxh=25)
 para(b,M,y+29,CW,size=9.2,leading=13,fill=MUTED,maxh=16)
 line(M,y+70,W-M,y+70);y+=85
label('Keep the arrangement workable',y=632)
para('Traditional payment, service trades, advertising exchanges and combined arrangements are welcome. Every partnership begins with clear scope, agreed value and commitments on both sides.',M,654,CW,size=10.1,leading=14.5,maxh=49)
external('douglas@legacyai.space','mailto:douglas@legacyai.space',M,709,260,size=11.5)
para('Douglas Talley · Brown County, Indiana',M+279,712,241,size=8.7,leading=12,maxh=24)
end('Your working brief')
assert PAGE==23,PAGE
assert len(SERVICE_PAGES)==54,len(SERVICE_PAGES)
C.save()
(HERE/'layout-log.json').write_text(json.dumps(LOG,indent=2))
(HERE/'build-manifest.json').write_text(json.dumps(dict(pages=PAGE,services=SERVICE_PAGES,artwork=ART,bytes=OUT.stat().st_size,sha256=sha256(OUT.read_bytes()).hexdigest()),indent=2))
print(json.dumps(dict(output=str(OUT),pages=PAGE,services=len(SERVICE_PAGES),illustrations=len(ART),bytes=OUT.stat().st_size),indent=2))
