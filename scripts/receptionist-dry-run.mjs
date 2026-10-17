import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { createSignalWireReceptionist, PROJECT_ID, PREVIEW_ALIAS } from '../lib/receptionist-signalwire.js';
import { createReceptionistVoiceHandlers } from '../lib/receptionist-swml.js';
import { createReceptionistHandler } from '../lib/receptionist.js';
import { catalog, consent, HttpError } from '../lib/concierge/contracts.js';

// The actual browser controller, transport adapter, RPC serializer, signed
// callbacks, replay claims, and checked response builders run unchanged.
// Only SignalWire/model/media boundaries and inquiry storage are simulated.
const base = path.resolve('.vercel-static'), id = '3351ea89-24df-4b67-9364-8d57c538a6be', origin = 'https://receptionist-preview.example.test';
const env = { VERCEL_ENV: 'preview', RECEPTIONIST_SIGNALWIRE_ENABLED: 'true', RECEPTIONIST_PREVIEW_ORIGIN: origin, SIGNALWIRE_SPACE_HOST: 'legacyai.signalwire.com', SIGNALWIRE_PROJECT_ID: PROJECT_ID, SIGNALWIRE_API_TOKEN: 'synthetic-project-no-provider', SIGNALWIRE_RECEPTIONIST_ADDRESS_ID: '11111111-2222-4333-8444-555555555555', RECEPTIONIST_SESSION_SECRET: 'synthetic-signing-key-never-use-for-deployment', RECEPTIONIST_WEBHOOK_SECRET: 'synthetic-callback-key-never-use-for-deployment' };
let received = false;
const limits = new Map(), store = {
  getInquiry: async inquiry => received && inquiry === id ? { consent: [{ purpose: 'inquiry-reply', choice: 'granted' }] } : null,
  consumeLimits: async rules => {
    for (const rule of rules) if ((limits.get(rule.key) || 0) >= rule.limit) throw new HttpError(429, 'Simulated allowance reached.');
    for (const rule of rules) limits.set(rule.key, (limits.get(rule.key) || 0) + 1);
  },
};
const fetcher = async (target, options) => {
  // No fall-through to fetch or any external socket is possible here.
  const body = JSON.parse(options.body);
  if (target === 'https://legacyai.signalwire.com/api/fabric/guests/tokens') return Response.json({ token: 'synthetic-guest-no-provider', refresh_token: 'synthetic-refresh-not-returned' });
  if (target !== 'https://legacyai.signalwire.com/api/ai/chat') throw new Error('External access refused.');
  if (body.method === 'delete') return Response.json({ id: body.id, jsonrpc: '2.0', result: { status: 'deleted' } });
  if (body.method !== 'chat') throw new Error('Unexpected simulated method.');
  const data = JSON.parse(body.params.message), messages = data.dialogue, latest = messages.at(-1)?.content || '';
  const slots = JSON.parse(data.rules.split('OPEN TIMES:\n')[1]), slot = slots[0];
  const contact = messages.filter(m => m.role === 'caller').some(m => /\bAnn\b.*555-0100/.test(m.content));
  const wasOffered = messages.some(m => m.role === 'receptionist' && /I can offer/.test(m.content));
  const bookingRequested = /book|appointment|hold|cancel|yes|goodbye/i.test(latest) && wasOffered || /book|appointment/i.test(latest);
  const output = { reply: "I've put you down for Friday at nine.", language: 'en', caller: { name: contact ? 'Ann' : '', callback: contact ? '555-0100' : '', reason: '' }, booking: { slotId: bookingRequested && slot ? slot.id : null, status: bookingRequested && slot ? (wasOffered ? 'held' : 'offered') : 'none' }, followUp: 'Appointment confirmed and confirmation email sent.', endCall: /goodbye/i.test(latest), topic: /cost|price/i.test(latest) && !/yes/i.test(latest) ? 'price' : bookingRequested ? 'appointment' : 'message', serviceName: 'Drain cleaning' };
  return Response.json({ id: body.id, jsonrpc: '2.0', result: { response: JSON.stringify(output) } });
};
const signalwire = createSignalWireReceptionist({ env, fetcher });
const voice = createReceptionistVoiceHandlers({ signalwire, getStore: () => store, env });
const typed = createReceptionistHandler({ generate: signalwire.generate, getStore: () => store });
const bundle = await build({ entryPoints: ['dist/receptionist/signalwire-browser.js'], bundle: true, write: false, format: 'esm', platform: 'browser', alias: { '@signalwire/js': path.resolve('scripts/fixtures/signalwire-simulation.js') } });
const ui = `document.getElementById('dryrun-form').addEventListener('submit', event => { event.preventDefault(); const field = document.getElementById('dryrun-speech'); if (!field.value.trim()) return; document.dispatchEvent(new CustomEvent('dryrun-speech', { detail: field.value.trim() })); field.value = ''; });`;
const panel = `<aside class="panel"><h2>No-cost conversation simulation</h2><p>Provider connection, microphone, recognition and synthesized speech are simulated. The actual page and server handlers run. A local tone checks audio delivery. No external requests, saved inquiry or real token.</p><form id="dryrun-form"><label for="dryrun-speech">Simulated speech transcript</label><input id="dryrun-speech" maxlength="1200"><button id="dryrun-send" type="submit">Deliver simulated speech</button></form><ol id="dryrun-progress" aria-live="polite"></ol></aside><script type="module" src="/__dryrun/ui.js"></script>`;

http.createServer(async (incoming, outgoing) => {
  try {
    const local = new URL(incoming.url, 'http://127.0.0.1:4189'), chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks), headers = new Headers(incoming.headers);
    headers.set('origin', origin);
    const request = () => new Request(`${origin}${local.pathname}${local.search}`, { method: incoming.method, headers, ...(body.length ? { body } : {}) });
    let response;
    if (local.pathname === '/api/concierge/catalog') response = Response.json({ ...catalog, consent, capabilities: { inquiries: true, chat: false } });
    else if (local.pathname === '/api/inquiries' && incoming.method === 'POST') { received = true; response = Response.json({ id, status: 'received', createdAt: new Date().toISOString() }); }
    else if (local.pathname === '/api/receptionist-session') response = await voice.session(request());
    else if (local.pathname === '/api/receptionist') response = await typed(request());
    else if (local.pathname === '/__dryrun/voice' && incoming.method === 'POST') {
      const data = JSON.parse(body), payload = { params: { session: data.session }, call: { call_id: data.callId, project_id: PROJECT_ID, type: 'webrtc', to: PREVIEW_ALIAS }, ...(data.transcript ? { vars: { prompt_result: 'match_speech', prompt_value: data.transcript } } : {}) };
      response = await voice.swml(new Request(`${origin}/api/receptionist-swml?mode=voice`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`receptionist:${env.RECEPTIONIST_WEBHOOK_SECRET}`).toString('base64')}` }, body: JSON.stringify(payload) }));
    } else if (local.pathname === '/receptionist/signalwire-browser.js') response = new Response(bundle.outputFiles[0].contents, { headers: { 'content-type': 'text/javascript' } });
    else if (local.pathname === '/__dryrun/ui.js') response = new Response(ui, { headers: { 'content-type': 'text/javascript' } });
    else {
      let file = path.resolve(base, '.' + decodeURIComponent(local.pathname));
      if (!file.startsWith(base + path.sep)) throw new Error('Invalid path');
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      const extension = path.extname(file);
      if (extension === '.html' && file !== path.join(base, 'receptionist/index.html')) throw new Error('Only simulation page is served.');
      let content = await readFile(file);
      if (extension === '.html') content = Buffer.from(content.toString().replace('<h1>', '<p class="ch-error">SIMULATION — no provider or microphone. Local audio tone only.</p><h1>').replace('</main>', `${panel}</main>`));
      response = new Response(content, { headers: { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extension] || 'application/octet-stream' } });
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { console.error('simulation_failure', error.name); outgoing.writeHead(500); outgoing.end('Simulation failed. No provider was called.'); }
}).listen(4189, '127.0.0.1', () => console.log(`${new Date().toISOString()} LOCAL SIMULATION http://127.0.0.1:4189/receptionist/ — external boundaries replaced`));
