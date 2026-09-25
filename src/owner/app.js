import { createAuthClient } from '@neondatabase/auth';
const $=id=>document.getElementById(id);
const node=(tag,text)=>{const el=document.createElement(tag);el.textContent=text;return el;};
let auth;
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
async function api(path,options={}){
  const session=await auth.getSession();
  if(session.error)throw Error(session.error.message || 'Your sign-in session could not be loaded.');
  const token=session.data?.session?.token;
  if(!token)throw Error('Sign in to view your private records.');
  const r=await fetch(path,{...options,headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{})},cache:'no-store'});
  if(!r.ok){let data;try{data=await r.json();}catch{}throw Error(data?.error||'The request could not be completed.');}
  return r;
}
function action(label,fn){const b=node('button',label);b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();status('');}catch(e){status(e.message,true);}finally{b.disabled=false;}};return b;}
async function refresh(){
  status('Loading your private records…');
  const [c,i]=await Promise.all([api('/api/owner/contacts').then(r=>r.json()),api('/api/owner/inquiries').then(r=>r.json())]);
  $('login').hidden=true;$('workspace').hidden=false;
  $('contacts').replaceChildren();
  if(!c.contacts.length)$('contacts').append(node('p','No identifying visitor details have been saved yet.'));
  c.contacts.forEach(contact=>{
    const a=node('article',''); const primary=contact.identifiers.find(x=>x.kind==='name')||contact.identifiers.find(x=>x.kind==='company')||contact.identifiers[0];
    a.append(node('h3',primary.value));
    contact.identifiers.forEach(x=>a.append(node('p',`${x.kind}: ${x.value}`)));
    const context=node('p',`Last seen ${new Date(contact.lastSeen).toLocaleString()} · ${contact.pages.join(', ')}`);context.className='muted';a.append(context);
    if(contact.ipAddresses.length)a.append(node('p',`IP context: ${contact.ipAddresses.join(', ')}`));
    a.append(node('p',`Permission signals at last capture: inquiry reply ${contact.signals.inquiryReply?'checked':'not checked'}; marketing ${contact.signals.marketing?'checked':'not checked'}. A checked box in a draft is not a submitted request.`));
    a.append(action('See sources',async()=>{const data=await api(`/api/owner/contacts?evidence=${encodeURIComponent(contact.visitorId)}`).then(r=>r.json());$('detail').hidden=false;$('detail').replaceChildren(node('h2',`Sources for ${primary.value}`));data.evidence.forEach(e=>$('detail').append(node('p',`${new Date(e.created_at).toLocaleString()} · ${e.page} · ${e.field_name}: ${e.identifiers.map(x=>`${x.kind}=${x.value}`).join('; ')}`)));$('detail').scrollIntoView({behavior:'smooth'});}));
    $('contacts').append(a);
  });
  $('inquiries').replaceChildren();
  if(!i.inquiries.length)$('inquiries').append(node('p','No inquiries received yet.'));
  i.inquiries.forEach(inquiry=>{const a=node('article','');a.append(node('h3',`${inquiry.name}${inquiry.company?' · '+inquiry.company:''}`),node('p',inquiry.message.slice(0,250)),action('Review inquiry',()=>detail(inquiry.id)));$('inquiries').append(a);});
  status(`Loaded ${c.contacts.length} recent visitor contacts and ${i.inquiries.length} recent inquiries.`);
}
async function detail(id){
  const {inquiry}=await api(`/api/owner/inquiries?id=${encodeURIComponent(id)}`).then(r=>r.json());
  $('detail').hidden=false;$('detail').replaceChildren(node('h2',inquiry.name),node('p',inquiry.email),node('pre',inquiry.message),node('h3','Recorded consent'));
  inquiry.consent.forEach(c=>$('detail').append(node('p',`${c.purpose}: ${c.choice} · ${new Date(c.created_at).toLocaleString()} · ${c.notice_text}`)));
  $('detail').append(action('Prepare a reply draft',async()=>{status('Preparing a draft; no email will be sent.');const {draft}=await api('/api/owner/follow-up',{method:'POST',body:JSON.stringify({inquiryId:id,instructions:''})}).then(r=>r.json());$('detail').append(node('h3',draft.subject),node('pre',draft.body),node('p','Saved as a draft. Nothing has been sent.'));}));
  inquiry.drafts.forEach(d=>$('detail').append(node('h3',d.subject),node('pre',d.body)));
  $('detail').scrollIntoView({behavior:'smooth'});
}
$('pa-form').onsubmit=async event=>{event.preventDefault();$('pa-ask').disabled=true;status('Your PA is reviewing the saved records…');try{const data=await api('/api/owner/assistant',{method:'POST',body:JSON.stringify({question:$('pa-question').value})}).then(r=>r.json());$('pa-answer').textContent=[data.answer.summary,...data.answer.nextSteps.map(s=>'• '+s),`Based on ${data.coverage.contacts} recent contacts and ${data.coverage.inquiries} recent inquiries.`].join('\n\n');status('');}catch(e){status(e.message,true);}finally{$('pa-ask').disabled=false;}};
$('refresh').onclick=()=>refresh().catch(e=>status(e.message,true));
$('export').onclick=async()=>{try{const r=await api('/api/owner/contacts?format=csv');const url=URL.createObjectURL(await r.blob());const a=node('a','');a.href=url;a.download='legacy-visitor-contacts.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('Contact sheet prepared: up to 10,000 recent visitor records and 10,000 submitted inquiries, with their separate sources and permissions.');}catch(e){status(e.message,true);}};
$('sign-in').onclick=async()=>{try{await auth.signIn.social({provider:'google',callbackURL:location.origin+'/owner/'});}catch(e){status('Google sign-in could not start. Please try again.',true);}};
$('sign-out').onclick=async()=>{await auth.signOut();$('workspace').hidden=true;$('login').hidden=false;$('contacts').replaceChildren();$('inquiries').replaceChildren();$('detail').replaceChildren();$('pa-answer').textContent='';status('Signed out.');};
try{const r=await fetch('/api/owner/config',{cache:'no-store'});if(!r.ok)throw Error('Owner sign-in is not connected on this deployment.');const config=await r.json();auth=createAuthClient(config.authUrl);$('sign-in').disabled=false;const session=await auth.getSession();if(session.data?.user)await refresh();else status('Sign in to open your workspace.');}catch(e){status(e.message,true);}

$('competitor-form').onsubmit=async event=>{event.preventDefault();$('competitor-run').disabled=true;status('Reading the published sources…');try{const data=await api('/api/owner/competitors',{method:'POST',body:JSON.stringify({urls:$('competitor-urls').value.split(/\n/).map(s=>s.trim()).filter(Boolean)})}).then(r=>r.json());const out=$('competitor-results');out.replaceChildren();if(data.insight){out.append(node('p',data.insight.summary));for(const [title,items] of [['Published observations',data.insight.observations],['Opportunities to consider',data.insight.opportunities]]){out.append(node('h3',title));for(const item of items)out.append(node('p',`${item.text} (Sources: ${item.sourceIds.join(', ')})`));}out.append(node('p','Unknowns: '+data.insight.unknowns.join(' ')));}for(const source of data.sources){const a=node('a',`${source.id}: ${source.title} — read ${new Date(source.asOf).toLocaleString()}`);a.href=source.url;a.target='_blank';a.rel='noopener noreferrer';out.append(node('p','').appendChild(a).parentNode);}for(const failure of data.failures||[])out.append(node('p',`${failure.url}: ${failure.error||failure.reason||'Could not retrieve this page.'}`));status('Source review complete.');}catch(e){status(e.message,true);}finally{$('competitor-run').disabled=false;}};
