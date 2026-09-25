import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readCatalog, selectedServices, composeBrief, readChatResponse, buildInquiry, readReceipt } from '../dist/concierge-core.js';

const services = JSON.parse(await readFile(new URL('../catalog/services.json', import.meta.url)));
const consent = { version: 'notice-v1', inquiryText: 'Save this inquiry and reply by email.', marketingText: 'Send optional marketing by email.' };

test('catalog uses actual unique service IDs; malformed IDs and duplicate IDs fail', () => {
  assert.equal(readCatalog({services,consent}).services.length, 54);
  assert.throws(() => readCatalog({services:[services[0],services[0]]}));
  assert.throws(() => readCatalog({services:[{...services[0],id:'javascript:alert(1)'}]}));
  assert.equal(readCatalog({services}).consent,null);
});

test('comparison keeps exact catalog claims, rejects unknown entries and caps selection', () => {
  assert.deepEqual(selectedServices([services[0].id,services[0].id,services[1].id],services),services.slice(0,2));
  assert.throws(() => selectedServices(['unavailable'],services));
  assert.throws(() => selectedServices(services.slice(0,4).map(s=>s.id),services));
});

test('brief preserves actual notes, marks omitted facts and does not invent scope', () => {
  const brief=composeBrief({challenge:'Loose rear bracket. Repair not included.',company:'Oak Workshop',goal:'Fewer repeated notes.'},[services[9]]);
  assert.match(brief,/Loose rear bracket\. Repair not included\./);
  assert.match(brief,/Timing\nNot supplied/);
  assert.match(brief,/The Report Writer/);
  assert.match(brief,/not agreed scope or a quote/);
  assert.throws(()=>composeBrief({},[]));
});

test('an empty chat response errors; generated links only use actual service IDs', () => {
  assert.throws(()=>readChatResponse({reply:'  '},services));
  const reply=readChatResponse({reply:'Actual response',serviceIds:['javascript:alert(1)',services[9].id],nextSteps:['Ask about current tools.',null]},services);
  assert.deepEqual(reply.serviceIds,[services[9].id]);
  assert.deepEqual(reply.nextSteps,['Ask about current tools.']);
});

test('sharing is affirmative and purpose-specific; no transcript or extra data leaks', () => {
  const fields={name:'An owner',email:'owner@example.test',message:'Please discuss report preparation.',company:'Example',confirmed:true,marketingOptIn:false,transcript:'must not transmit'};
  const payload=buildInquiry(fields,[services[9].id],services,consent);
  assert.deepEqual(Object.keys(payload).sort(),['approval','company','email','message','name','serviceIds']);
  assert.equal(payload.approval.marketingOptIn,false);
  assert.equal(payload.approval.consentVersion,'notice-v1');
  assert.throws(()=>buildInquiry({...fields,confirmed:false},[],services,consent));
  assert.throws(()=>buildInquiry(fields,[],services,null));
  assert.throws(()=>buildInquiry({...fields,email:'bad'},[],services,consent));
});

test('no saved state is accepted without a valid durable receipt', () => {
  assert.throws(()=>readReceipt({status:'received'}));
  assert.throws(()=>readReceipt({id:'f20826b1-4c2a-4cc7-925f-4cfa827de62e',createdAt:'today',status:'received'}));
  assert.throws(()=>readReceipt({id:'f20826b1-4c2a-4cc7-925f-4cfa827de62e',createdAt:'2026-09-25T12:00:00Z',status:'queued'}));
  assert.equal(readReceipt({id:'f20826b1-4c2a-4cc7-925f-4cfa827de62e',createdAt:'2026-09-25T12:00:00Z',status:'received',replayed:true}).replayed,true);
});
