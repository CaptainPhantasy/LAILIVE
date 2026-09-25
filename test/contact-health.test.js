import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCSV,guessMapping,analyze,draftRows,encodeCSV,issueRows} from '../dist/contact-health/core.js';
test('CSV preserves quoted commas, embedded newlines and escaped quotes; rejects broken rows',()=>{
 const data=parseCSV('Name,Email,Notes\r\n"A, B",a@example.test,"Line 1\nLine ""2"""');
 assert.deepEqual(data.rows[0].values,['A, B','a@example.test','Line 1\nLine "2"']);
 assert.throws(()=>parseCSV('Name,Email\nA,a@example.test,extra'));
 assert.throws(()=>parseCSV('Name,Email\n"unfinished,a@example.test'));
});
test('real rows produce missing, duplicate and shared-contact checks without merging people',()=>{
 const data=parseCSV('Name,Email,Phone\nAlice,a@example.test,\nAlice,a@example.test,\nBob,a@example.test,\n,,');const report=analyze(data,guessMapping(data.headers));
 assert.equal(report.summary.records,4);assert.equal(report.summary.exactDuplicates,1);assert.equal(report.summary.possibleConflicts,3);
 assert(report.issues.some(i=>i.code==='missing_name'));assert(report.issues.some(i=>i.code==='missing_contact'));
 assert.equal(draftRows(data,report).length,4);assert.equal(draftRows(data,report,{removeDuplicates:true}).length,3);
 assert.equal(data.rows.length,4);assert(issueRows(data,report).length>1);
});
test('export preserves columns and quotes while neutralizing spreadsheet formulas',()=>{
 const output=encodeCSV([['Name','Phone','Notes'],['=HYPERLINK("bad")','+15551234567','a,b\nline']]);
 assert.match(output,/"'=HYPERLINK/);assert.match(output,/"'\+1555/);
 const parsed=parseCSV(output);assert.equal(parsed.rows[0].values[2],'a,b\nline');
});
test('a stray x fails the phone check; a trailing extension passes',()=>{
 const data=parseCSV('Name,Phone\nAnn,xxx-555-123-4567\nBen,555-123-4567 x12\nCy,555-987-6543\nDi,555-987-6543');
 const report=analyze(data,guessMapping(data.headers));
 const flagged=id=>report.issues.some(i=>i.record===id&&i.code==='phone_format');
 assert(flagged(2));assert(!flagged(3));assert(!flagged(4));assert(!flagged(5));
});
test('shared-contact groups list related records without rescanning the group per row',()=>{
 const data=parseCSV('Name,Email\nP1,p@x.test\nP2,p@x.test\nP3,p@x.test\nP4,q@x.test');
 const report=analyze(data,guessMapping(data.headers));
 const grouped=report.issues.filter(i=>i.related.length);
 assert.deepEqual(grouped.map(i=>[i.record,i.related]),[[2,[3,4]],[3,[2,4]],[4,[2,3]]]);
});

