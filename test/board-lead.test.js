import test from 'node:test';
import assert from 'node:assert/strict';
import {withBoardLead} from '../lib/board-lead.js';
const id='3351ea89-24df-4b67-9364-8d57c538a6be';
const req=extra=>new Request('https://example.test/api/board',{method:'POST',headers:extra});
test('Board denies absent receipt before database or generation',async()=>{let calls=0;const h=withBoardLead(()=>{calls++;},()=>{calls++;});assert.equal((await h(req({}))).status,403);assert.equal(calls,0);});
test('Board requires durable inquiry and granted reply consent before generation',async()=>{let calls=0;for(const inquiry of [null,{consent:[]},{consent:[{purpose:'inquiry-reply',choice:'withdrawn'}]}]){const h=withBoardLead(()=>{calls++;},()=>({getInquiry:async()=>inquiry}));assert.equal((await h(req({'x-legacy-inquiry':id}))).status,403);}assert.equal(calls,0);});
test('Board with a received inquiry checks persistent allowance then calls its real handler',async()=>{const order=[];const h=withBoardLead(()=>{order.push('handler');return new Response('allowed');},()=>({getInquiry:async()=>({consent:[{purpose:'inquiry-reply',choice:'granted'}]}),consumeLimits:async rules=>{assert.equal(rules.length,2);order.push('limit');}}));assert.equal(await(await h(req({'x-legacy-inquiry':id}))).text(),'allowed');assert.deepEqual(order,['limit','handler']);});
