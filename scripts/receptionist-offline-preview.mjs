import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createReceptionistHandler } from '../lib/receptionist.js';
import { catalog, consent } from '../lib/concierge/contracts.js';

// Isolated UI fixture: no real receipt, database, model, guest mint or audio call.
const base = path.resolve('.vercel-static'), id = '3351ea89-24df-4b67-9364-8d57c538a6be';
let received = false;
const handler = createReceptionistHandler({ getStore: () => ({ getInquiry: async inquiry => received && inquiry === id ? { consent: [{ purpose: 'inquiry-reply', choice: 'granted' }] } : null, consumeLimits: async () => {} }), generate: async input => ({
  reply: input.messages.length ? 'Your Friday appointment is confirmed and the text was sent.' : `Hello, ${input.profile.business}. How can I help?`,
  language: input.profile.languages[0], caller: { name: '', callback: '', reason: input.messages.length ? 'Appointment request' : '' }, booking: { slotId: null, status: 'none' }, followUp: '', endCall: false,
}) });

http.createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, 'http://127.0.0.1:4188');
    let response;
    if (url.pathname === '/api/concierge/catalog') response = Response.json({ ...catalog, consent, capabilities: { inquiries: true, chat: false } });
    else if (url.pathname === '/api/inquiries' && incoming.method === 'POST') {
      for await (const _chunk of incoming) { /* discard synthetic form data */ }
      received = true; response = Response.json({ id, status: 'received', createdAt: new Date().toISOString() });
    } else if (url.pathname === '/api/receptionist' && incoming.method === 'POST') {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      response = await handler(new Request(url, { method: incoming.method, headers: incoming.headers, body: Buffer.concat(chunks) }));
    } else if (url.pathname === '/api/receptionist-session') response = Response.json({ error: 'Offline fixture: browser voice is disabled. No token or call was created.' }, { status: 503 });
    else {
      let file = path.resolve(base, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(base + path.sep)) throw new Error('Invalid path');
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      const extension = path.extname(file);
      if (extension === '.html' && file !== path.join(base, 'receptionist/index.html')) throw new Error('Only the test page is served.');
      let data = await readFile(file);
      if (extension === '.html') data = Buffer.from(data.toString().replace('<h1>', '<p class="ch-error">OFFLINE TEST — synthetic replies and receipt. No provider calls or saved inquiry.</p><h1>'));
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
      response = new Response(data, { headers: { 'Content-Type': types[extension] || 'application/octet-stream' } });
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(404); outgoing.end('Offline fixture unavailable. Run npm run build first.'); }
}).listen(4188, '127.0.0.1', () => console.log('OFFLINE fixture: http://127.0.0.1:4188/receptionist/ — no external APIs'));
