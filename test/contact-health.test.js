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
