import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createQuotePhotoHandler } from '../lib/quote-photo.js';
import { signOwnerToken } from '../lib/owner-documents-core.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
  QUOTE_SECRET: 'quote-secret',
};
const photo = Buffer.alloc(200, 7).toString('base64');
const upload = (body, secret = 'quote-secret') => new Request('https://legacyai.space/api/frontdesk/quote-photo', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-frontdesk-secret': secret }, body: JSON.stringify(body),
});
const tokenFor = (id) => signOwnerToken({ id, scope: 'quote-photo', exp: Date.now() + 86400000 }, env.RECEPTIONIST_SESSION_SECRET);
const linkFor = id => `https://legacyai.space/api/frontdesk/quote-photo?token=${encodeURIComponent(tokenFor(id))}`;
const save = (id, fields) => new Request(linkFor(id), {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokenFor(id), action: 'save', ...fields }),
});
const sendQuote = (id, email) => new Request(linkFor(id), {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokenFor(id), action: 'send', customer_email: email }),
});
const failing = async () => { throw new Error('provider down'); };

test('a photo upload is validated and survives a failed description', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createQuotePhotoHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env, describe: failing });
  try {
    assert.equal((await handler(upload({ mime: 'image/png', data: photo }, 'wrong'))).status, 401);
    assert.equal((await handler(upload({ mime: 'image/gif', data: photo }))).status, 400);
    assert.equal((await handler(upload({ mime: 'image/png', data: Buffer.alloc(10, 1).toString('base64') }))).status, 400);
    assert.equal((await handler(upload({ mime: 'image/png', data: Buffer.alloc(2600000, 1).toString('base64') }))).status, 413);
    const created = await (await handler(upload({ mime: 'image/png', data: photo, filename: 'leak.png', note: 'Water under the sink.' }))).json();
    assert.equal(created.status, 'draft');
    assert.equal(created.described, false);
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.match(sent[0].body, /No description was generated/);
    assert.equal((await pg.query('SELECT description FROM legacy_quote_photos')).rows[0].description, '');
  } finally { await pg.close(); }
});

test('a working description is shown with the photo, and the photo bytes come back under the same token', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const handler = createQuotePhotoHandler({ getDb: () => db, mail: async () => true, env, describe: async ({ note }) => `Visible corrosion near the fitting. Owner note said: ${note}` });
  try {
    const created = await (await handler(upload({ mime: 'image/jpeg', data: photo, filename: 'sink.jpg', note: 'Rust line at the base.' }))).json();
    assert.equal(created.described, true);
    const page = await handler(new Request(linkFor(created.id)));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Rust line at the base/);
    assert.match(html, /Visible corrosion/);
    const image = await handler(new Request(`${linkFor(created.id)}&photo=1`));
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.equal(Buffer.from(await image.arrayBuffer()).length, 200);
    assert.equal((await handler(new Request('https://legacyai.space/api/frontdesk/quote-photo?token=bad'))).status, 401);
  } finally { await pg.close(); }
});

test('the owner prices the quote and the price is stored in cents', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createQuotePhotoHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env, describe: failing });
  try {
    const created = await (await handler(upload({ mime: 'image/png', data: photo, filename: 'job.png' }))).json();
    assert.equal((await handler(save(created.id, { quote: 'short', price: '450.00' }))).status, 400);
    assert.equal((await handler(save(created.id, { quote: 'Replace the trap and the supply line.', price: '4.5.0' }))).status, 400);
    const saved = await handler(save(created.id, { quote: 'Replace the trap and the supply line. Includes one visit.', price: '450.50' }));
    assert.equal(saved.status, 200);
    const row = (await pg.query('SELECT status,price_cents,quote FROM legacy_quote_photos')).rows[0];
    assert.equal(row.status, 'priced');
    assert.equal(row.price_cents, 45050);
    assert.match(row.quote, /Replace the trap/);
    assert.equal(sent.filter(message => /Quote priced/.test(message.subject)).length, OWNER_ADDRESSES.length);
    assert.match(await (await handler(new Request(linkFor(created.id)))).text(), /\$450\.50/);
  } finally { await pg.close(); }
});

test('a priced quote is sent to the customer once, then locks', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createQuotePhotoHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env, describe: failing });
  try {
    const created = await (await handler(upload({ mime: 'image/png', data: photo, filename: 'send.png' }))).json();
    assert.equal((await handler(sendQuote(created.id, 'customer@example.com'))).status, 409);
    await handler(save(created.id, { quote: 'Replace the trap and dry the shelf.', price: '300.00' }));
    assert.equal((await handler(sendQuote(created.id, 'not-an-email'))).status, 400);
    const page = await handler(sendQuote(created.id, 'customer@example.com'));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Quote sent to customer@example\.com/);
    assert.equal(sent.filter(message => message.to === 'customer@example.com').length, 1);
    assert.match(sent.find(message => message.to === 'customer@example.com').body, /Total: \$300\.00/);
    const again = await handler(sendQuote(created.id, 'customer@example.com'));
    assert.match(await again.text(), /already sent/);
    assert.equal(sent.filter(message => message.to === 'customer@example.com').length, 1);
    const row = (await pg.query('SELECT status,customer_email,sent_at IS NOT NULL AS sent FROM legacy_quote_photos')).rows[0];
    assert.equal(row.status, 'sent');
    assert.equal(row.customer_email, 'customer@example.com');
    assert.equal(row.sent, true);
    assert.match(await (await handler(save(created.id, { quote: 'A changed quote that should not stick.', price: '1.00' }))).text(), /cannot be edited/);
    assert.equal((await pg.query('SELECT price_cents FROM legacy_quote_photos')).rows[0].price_cents, 30000);
    assert.equal(sent.filter(message => /Quote sent: send\.png/.test(message.subject)).length, OWNER_ADDRESSES.length);
  } finally { await pg.close(); }
});
