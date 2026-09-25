import test from 'node:test';
import assert from 'node:assert/strict';
import { VISITOR_NOTICE_VERSION, CAPTURE_LIMIT, publicCapturePage, eligibleCaptureField, explicitIdentifierField, contactCandidate, visitorPayload, recentCaptureAttempts } from '../dist/visitor-contact.js';
import { visitorInput } from '../lib/concierge/identifiers.js';

test('capture excludes owner and local-only contact health pages and never accepts query context', () => {
  for(const path of ['/owner','/owner/','/owner/index.html','/contact-health','/contact-health/','/api/visitor','//other.test','/brief/?email=a@example.test','/brief/#name']) assert.equal(publicCapturePage(path),false,path);
  for(const path of ['/','/intake/','/solutions/','/board/','/deal/']) assert.equal(publicCapturePage(path),true,path);
});

test('eligible public fields never include password, payment, auth, file or bulk fields', () => {
  const text={tagName:'INPUT',type:'text',id:'cg-name',label:'Your name'};
  assert.equal(eligibleCaptureField(text),true);
  for(const type of ['password','file','hidden','checkbox','number']) assert.equal(eligibleCaptureField({...text,type}),false,type);
  for(const id of ['api-key','credit-card','csv-text','bank-account','verification-code','auth-code']) assert.equal(eligibleCaptureField({...text,id,label:''}),false,id);
  assert.equal(eligibleCaptureField({...text,autocomplete:'cc-number'}),false);
  assert.equal(eligibleCaptureField({...text,label:'Account password'}),false);
  assert.equal(eligibleCaptureField({...text,excluded:true}),false);
  assert.equal(eligibleCaptureField({...text,readOnly:true}),false);
  assert.equal(eligibleCaptureField({tagName:'TEXTAREA',id:'cg-next-steps'}),false);
});

test('actual identifiers and clear self-description qualify; blanks and generic activity do not', () => {
  for(const name of ['cg-name','cg-company','cg-share-company','cg-phone','cg-address','lg-name','lg-company']) assert.equal(contactCandidate(name,'Oak Street'), 'Oak Street');
  assert.equal(contactCandidate('cg-question','Please reply to owner@example.test.'),'Please reply to owner@example.test.');
  assert.equal(contactCandidate('cg-challenge','Reach me at 812-555-0123.'),'Reach me at 812-555-0123.');
  assert.equal(contactCandidate('cg-challenge','My company is Oak Street Plumbing.'),'My company is Oak Street Plumbing.');
  for(const text of ['',' ','A','Hello','I need a report','Tell me about scheduling.']) assert.equal(contactCandidate('cg-question',text),null,text);
  assert.equal(contactCandidate('cg-question','My company '+ 'x'.repeat(9000)).length,8000);
});

test('generic labelled lead fields retain their actual field name and raw value', () => {
  assert.equal(explicitIdentifierField({id:'lead-person',label:'Your full name'}),true);
  assert.equal(explicitIdentifierField({id:'lead-business',label:'Business name'}),true);
  assert.equal(explicitIdentifierField({id:'service-name',label:'Service name'}),false);
  const payload=visitorPayload({visitorId:'f20826b1-4c2a-4cc7-925f-4cfa827de62e',page:'/intake/',fieldName:'lead-person',value:'Jamie Owner',labelledIdentifier:true});
  assert.equal(payload.fieldName,'lead-person');
  assert.equal(payload.value,'Jamie Owner');
  assert.equal('labelledIdentifier' in payload,false);
});

test('bulk CSV and pasted contact lists are not collected through other fields', () => {
  assert.equal(contactCandidate('cg-question','name,email\nOwner,owner@example.test'),null);
  assert.equal(contactCandidate('cg-question','Alice,a@example.test\nBob,b@example.test\nCara,c@example.test'),null);
  assert.equal(contactCandidate('cg-question',Array.from({length:6},(_,i)=>`person${i}@example.test`).join(' ')),null);
});

test('payload matches real backend schema and includes only allowed context and draft signals', () => {
  const payload=visitorPayload({visitorId:'f20826b1-4c2a-4cc7-925f-4cfa827de62e',page:'/intake/',fieldName:'cg-email',value:'owner@example.test',inquiryReply:true,marketing:false});
  assert.equal(visitorInput.safeParse(payload).success,true);
  assert.equal(payload.noticeVersion,VISITOR_NOTICE_VERSION);
  assert.deepEqual(payload.signals,{collection:'notice-shown',inquiryReply:true,marketing:false});
  assert.deepEqual(Object.keys(payload),['visitorId','page','fieldName','value','noticeVersion','signals']);
  assert.equal(visitorPayload({...payload,visitorId:'not-an-id'}),null);
  assert.equal(visitorPayload({...payload,page:'/owner/'}),null);
});

test('local request budget is bounded to 60 per rolling hour, discarding invalid timestamps', () => {
  assert.equal(CAPTURE_LIMIT,60);
  assert.deepEqual(recentCaptureAttempts([1,1000000,3999999,4000000,4000001,NaN,'3999999'],4000000),[1000000,3999999,4000000]);
  assert.deepEqual(recentCaptureAttempts(null,4000000),[]);
});
