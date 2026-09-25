import { readCatalog, buildInquiry, readReceipt } from './concierge-core.js';

const PROFILE_KEY = 'legacy-inquiry-contact-v1';
const received = new Map(), attempts = new Map();
let active = null;

export function rememberLeadContact(fields) {
  const contact = Object.fromEntries(['name', 'email', 'company'].map(key => [key, typeof fields[key] === 'string' ? fields[key].trim() : '']));
  try { sessionStorage.setItem(PROFILE_KEY, JSON.stringify(contact)); } catch { /* The form still works when storage is blocked. */ }
  return contact;
}

export function readLeadContact() {
  let contact = {};
  try { contact = JSON.parse(sessionStorage.getItem(PROFILE_KEY) || '{}'); } catch { /* No saved prefill. */ }
  return Object.fromEntries(['name', 'email', 'company'].map(key => [key, typeof contact?.[key] === 'string' ? contact[key] : '']));
}

async function jsonRequest(url, options, fetcher) {
  const response = await fetcher(url, { ...options, credentials: 'same-origin', headers: { Accept: 'application/json', ...(options?.body ? { 'Content-Type': 'application/json' } : {}), ...options?.headers } });
  let value;
  try { value = await response.json(); } catch { throw new Error('The service did not return a readable confirmation. Please try again.'); }
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : 'We could not confirm your inquiry. Please try again.');
  return value;
}

export async function loadLeadCatalog({ fetcher = fetch, signal } = {}) {
  const catalog = readCatalog(await jsonRequest('/api/concierge/catalog', { signal, cache: 'no-store' }, fetcher));
  if (!catalog.capabilities.inquiries || !catalog.consent) throw new Error('The inquiry service is not connected right now. Please try again or email douglas@legacyai.space about the work you have in mind.');
  return catalog;
}

export function prepareLeadInquiry(fields, context, catalog) {
  const detail = typeof fields.request === 'string' ? fields.request.trim() : '';
  if (detail.length < 8) throw new Error('Add a few words about the work you would like to discuss.');
  // Only explicit contact fields and the reviewed request are sent. File data,
  // local audit results, contact rows, and unrelated form values never enter here.
  return buildInquiry({ name: fields.name, email: fields.email, company: fields.company, message: `${context.purpose}\n\n${detail}`, confirmed: fields.confirmed, marketingOptIn: fields.marketingOptIn }, context.serviceIds || [], catalog.services, catalog.consent);
}

export async function sendLeadInquiry(payload, { key, fetcher = fetch, signal } = {}) {
  return readReceipt(await jsonRequest('/api/inquiries', { method: 'POST', signal, headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload) }, fetcher));
}

export function requestLead(context) {
  const contextKey = context.key || JSON.stringify([context.purpose, context.request || '', context.serviceIds || []]);
  if (received.has(contextKey)) return Promise.resolve(received.get(contextKey));
  if (active) return active.key === contextKey ? active.promise : Promise.reject(new Error('Finish or close the current inquiry before starting another.'));
  const opener = document.activeElement, dialog = document.createElement('dialog');
  dialog.className = 'lg-dialog'; dialog.setAttribute('aria-labelledby', 'lg-title');
  dialog.innerHTML = `<div class="lg-top"><p class="lg-kicker">A conversation about your business</p><button type="button" id="lg-close" aria-label="Close inquiry">×</button></div>
    <h2 id="lg-title">Where should Douglas follow up?</h2><p id="lg-intro"></p>
    <p id="lg-loading" role="status">Connecting to the inquiry service…</p>
    <p id="lg-error" role="alert" hidden></p><button id="lg-retry" type="button" hidden>Try connecting again</button>
    <form id="lg-form"><fieldset id="lg-fields" disabled><legend class="lg-sr-only">Your inquiry</legend>
      <div class="lg-contact"><label>Your name<input id="lg-name" name="name" autocomplete="name" maxlength="120" required></label><label>Reply email<input id="lg-email" name="email" type="email" autocomplete="email" maxlength="254" required></label></div>
      <label>Business name <span>(optional)</span><input id="lg-company" name="company" autocomplete="organization" maxlength="160"></label>
      <label id="lg-request-label">What would you like to work through?<textarea id="lg-request" name="request" rows="3" minlength="8" maxlength="6000" required></textarea></label>
      <label class="lg-choice"><input id="lg-confirm" type="checkbox" required><span id="lg-inquiry-notice"></span></label>
      <label class="lg-choice"><input id="lg-marketing" type="checkbox"><span id="lg-marketing-notice"></span></label>
      <p class="lg-note">Only these contact details and your request are sent to Douglas. The result appears on this page; no email is sent automatically.</p>
      <button id="lg-send" class="lg-primary" type="submit">Send inquiry &amp; continue</button>
    </fieldset></form><p class="lg-foot">Prefer email? <a href="mailto:douglas@legacyai.space">douglas@legacyai.space</a></p>`;
  document.body.append(dialog);
  const $ = id => dialog.querySelector(`#${id}`);
  $('lg-title').textContent = context.title || 'Where should Douglas follow up?';
  $('lg-intro').textContent = context.intro;
  $('lg-request').value = context.request || '';
  const existing = readLeadContact();
  for (const key of ['name', 'email', 'company']) {
    const current = document.getElementById(key === 'company' ? 'cg-share-company' : `cg-${key}`)?.value?.trim();
    $(`lg-${key}`).value = current || existing[key];
  }
  if (context.localNote) dialog.querySelector('.lg-note').textContent = context.localNote;
  let catalog = null, saving = false, finished = false, controller = new AbortController();
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  active = { key: contextKey, promise };
  const remember = () => rememberLeadContact({ name: $('lg-name').value, email: $('lg-email').value, company: $('lg-company').value });
  const close = receipt => {
    if (finished) return;
    finished = true; remember(); controller.abort(); dialog.close(); dialog.remove(); active = null;
    if (opener?.isConnected) opener.focus();
    resolve(receipt || null);
  };
  $('lg-close').addEventListener('click', () => close(null));
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(null); });
  for (const id of ['lg-name', 'lg-email', 'lg-company', 'lg-request']) $(id).addEventListener('input', () => { $('lg-confirm').checked = false; $('lg-marketing').checked = false; remember(); });
  async function load() {
    $('lg-error').hidden = true; $('lg-retry').hidden = true; $('lg-loading').textContent = 'Connecting to the inquiry service…';
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      catalog = await loadLeadCatalog({ signal: controller.signal });
      if (finished) return;
      $('lg-inquiry-notice').textContent = catalog.consent.inquiryText;
      $('lg-marketing-notice').textContent = catalog.consent.marketingText;
      $('lg-fields').disabled = false; $('lg-loading').textContent = '';
      (existing.name && existing.email && $('lg-request').value ? $('lg-confirm') : $('lg-name')).focus();
    } catch (error) {
      if (finished) return;
      $('lg-loading').textContent = ''; $('lg-error').hidden = false;
      $('lg-error').textContent = error.name === 'AbortError' ? 'The connection timed out. Please try again; no inquiry receipt has been confirmed.' : error.message;
      $('lg-retry').hidden = false;
    } finally { clearTimeout(timeout); }
  }
  $('lg-retry').addEventListener('click', () => { controller = new AbortController(); load(); });
  $('lg-form').addEventListener('submit', async event => {
    event.preventDefault(); if (saving || !catalog) return;
    let payload;
    try { payload = prepareLeadInquiry({ ...remember(), request: $('lg-request').value, confirmed: $('lg-confirm').checked, marketingOptIn: $('lg-marketing').checked }, context, catalog); }
    catch (error) { $('lg-error').hidden = false; $('lg-error').textContent = error.message; return; }
    const serialized = JSON.stringify(payload);
    let attempt = attempts.get(contextKey);
    if (!attempt || attempt.serialized !== serialized) { attempt = { serialized, key: crypto.randomUUID() }; attempts.set(contextKey, attempt); }
    saving = true; $('lg-fields').disabled = true; $('lg-error').hidden = true; $('lg-loading').textContent = 'Sending the inquiry you reviewed…';
    controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const receipt = await sendLeadInquiry(payload, { key: attempt.key, signal: controller.signal });
      if (finished) return;
      received.set(contextKey, receipt); close(receipt);
    } catch (error) {
      if (finished) return;
      $('lg-error').hidden = false; $('lg-error').textContent = error.name === 'AbortError' ? 'Receipt not confirmed. Retry the unchanged inquiry to check the same submission; it will not create another inquiry.' : error.message;
      $('lg-loading').textContent = ''; $('lg-fields').disabled = false;
    } finally { clearTimeout(timeout); saving = false; }
  });
  dialog.showModal(); load(); return promise;
}
