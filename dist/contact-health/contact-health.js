import {LIMITS,parseCSV,guessMapping,analyze,contactFor,encodeCSV,draftRows,issueRows} from './core.js';
const $=id=>document.getElementById(id);
let data=null,report=null,mapping=null,page=0,excluded=new Set();
const pageSize=25;
const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
function error(message=''){$('error').textContent=message;$('error').hidden=!message;}
function invalidate(){data=null;report=null;mapping=null;page=0;excluded.clear();$('mapping-panel').hidden=true;$('results').hidden=true;$('status').textContent='';error();}
function run(action){try{error();action();}catch(e){error(e.message);}}
$('csv-text').addEventListener('input',invalidate);
$('delimiter').addEventListener('change',invalidate);
$('csv-file').addEventListener('change',async()=>{
 const file=$('csv-file').files[0];if(!file)return;invalidate();
 try{if(file.size>LIMITS.bytes)throw new Error('Choose a CSV file no larger than 2 MB.');$('csv-text').value=await file.text();$('status').textContent='File loaded on this device. Read the columns to continue.';}catch(e){error(e.message);}
});
$('clear-all').addEventListener('click',()=>{invalidate();$('csv-file').value='';$('csv-text').value='';$('status').textContent='The page has been cleared.';$('csv-text').focus();});
$('read-csv').addEventListener('click',()=>run(()=>{
 invalidate();data=parseCSV($('csv-text').value,$('delimiter').value==='tab'?'\t':$('delimiter').value);const suggested=guessMapping(data.headers);
 document.querySelectorAll('[data-role]').forEach(select=>{
  select.replaceChildren();const empty=node('option','Not present');empty.value='-1';select.append(empty);
  data.headers.forEach((header,index)=>{const option=node('option',`${index+1}. ${header||'(unnamed column)'}`);option.value=String(index);select.append(option);});
  select.value=String(suggested[select.dataset.role]);
 });
 $('loaded-summary').textContent=`${data.rows.length.toLocaleString()} records and ${data.headers.length} columns read.`;$('mapping-panel').hidden=false;$('mapping-heading').focus();
}));
document.querySelectorAll('[data-role]').forEach(select=>select.addEventListener('change',()=>{report=null;$('results').hidden=true;}));
$('check-list').addEventListener('click',()=>run(()=>{
 mapping=Object.fromEntries([...document.querySelectorAll('[data-role]')].map(s=>[s.dataset.role,Number(s.value)]));report=analyze(data,mapping);excluded.clear();page=0;
 const summary=$('summary');summary.replaceChildren();
 for(const [key,label] of [['records','Records checked'],['withIssues','Records to review'],['exactDuplicates','Extra exact rows'],['possibleConflicts','Possible conflicts']]){const wrap=node('div');wrap.append(node('dt',label),node('dd',report.summary[key].toLocaleString()));summary.append(wrap);}
 $('results').hidden=false;renderRecords();$('results-heading').focus();$('status').textContent='Check complete. Review the flagged records before downloading.';
}));
function updateDraft(){if(!report)return;const keep=draftRows(data,report,{excluded,removeDuplicates:$('remove-duplicates').checked,trim:$('trim-spaces').checked});$('draft-summary').textContent=`${keep.length.toLocaleString()} of ${data.rows.length.toLocaleString()} records will be in your draft. ${data.rows.length-keep.length} left out. Original data is unchanged.`;}
function renderRecords(){
 if(!report)return;const rows=data.rows.filter(row=>$('review-filter').value==='all'||report.byRecord.get(row.id).length);const pages=Math.max(1,Math.ceil(rows.length/pageSize));page=Math.max(0,Math.min(page,pages-1));const container=$('records');container.replaceChildren();
 if(!rows.length)container.append(node('p','No records match this view. You can review all records or download your draft.'));
 for(const row of rows.slice(page*pageSize,(page+1)*pageSize)){
  const contact=contactFor(row,mapping),article=node('article',undefined,'ch-record'+(excluded.has(row.id)?' ch-omitted':''));
  const header=node('div',undefined,'ch-record-head'),about=node('div');about.append(node('p',`Record ${row.id} · CSV line ${row.line}`,'ch-record-number'),node('h3',contact.name||'Name not supplied'),node('p',[contact.email,contact.phone].filter(Boolean).join(' · ')||'No contact details','ch-contact'));
  const label=node('label',undefined,'ch-check'),check=document.createElement('input');check.type='checkbox';check.checked=excluded.has(row.id);check.addEventListener('change',()=>{check.checked?excluded.add(row.id):excluded.delete(row.id);article.classList.toggle('ch-omitted',check.checked);updateDraft();});label.append(check,node('span','Leave this record out of the draft'));header.append(about,label);article.append(header);
  const issues=report.byRecord.get(row.id);if(issues.length){const list=node('ul',undefined,'ch-issues');for(const issue of issues){const item=node('li',issue.message);if(issue.fields.length)item.append(node('small','Fields: '+issue.fields.join(', ')));if(issue.related.length)item.append(node('small','Related records: '+issue.related.join(', ')));list.append(item);}article.append(list);}else article.append(node('p','No issues found by these checks. This does not confirm contact details are current.','ch-small'));
  const details=node('details'),fields=node('dl',undefined,'ch-fields');details.append(node('summary','See every original field'));data.headers.forEach((h,i)=>fields.append(node('dt',h||`Column ${i+1}`),node('dd',row.values[i]||'(empty)')));details.append(fields);article.append(details);container.append(article);
 }
 $('page-label').textContent=`Page ${page+1} of ${pages} · ${rows.length.toLocaleString()} records`;$('previous').disabled=page===0;$('next').disabled=page>=pages-1;updateDraft();
}
$('review-filter').addEventListener('change',()=>{page=0;renderRecords();});$('previous').addEventListener('click',()=>{page--;renderRecords();});$('next').addEventListener('click',()=>{page++;renderRecords();});
['remove-duplicates','trim-spaces'].forEach(id=>$(id).addEventListener('change',updateDraft));
function download(rows,name){const url=URL.createObjectURL(new Blob([encodeCSV(rows)],{type:'text/csv;charset=utf-8'}));const link=node('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);$('status').textContent='Download prepared. Nothing was uploaded or imported.';}
$('download-draft').addEventListener('click',()=>run(()=>{if(!report)throw new Error('Check your list first.');download([data.headers,...draftRows(data,report,{excluded,removeDuplicates:$('remove-duplicates').checked,trim:$('trim-spaces').checked})],'legacy-ai-contact-draft.csv');}));
$('download-issues').addEventListener('click',()=>run(()=>{if(!report)throw new Error('Check your list first.');download(issueRows(data,report),'legacy-ai-contact-issues.csv');}));
