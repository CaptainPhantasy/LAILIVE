// Public contact enrichment only. A draft checkbox state never grants outreach permission.
export const VISITOR_NOTICE_VERSION = 'visitor-contact-2026-09-25-v1';
export const CAPTURE_LIMIT = 60;
const HOUR = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIRECT_FIELDS = new Set(['cg-name', 'cg-company', 'cg-share-company', 'cg-phone', 'cg-address', 'lg-name', 'lg-company']);
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE = /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\b\d{3})[ .-]\d{3}[ .-]\d{4}\b/;
const SELF_DESCRIPTION = /\b(?:my|our)\s+(?:name|company|business|address|phone)\b|\b(?:i am|i'm|we are|we're)\b|\b(?:name|company|business|address|phone)\s*:/i;
const SENSITIVE = /password|passcode|passwd|\bpin\b|\botp\b|token|secret|api[-_\s]?key|credit|debit|card|\bcvv\b|\bcvc\b|cc-|billing|bank|iban|routing|\bssn\b|social.?security|verification|auth|csv|upload|bulk|file/i;

export function publicCapturePage(path) {
  return typeof path === 'string' && /^\/(?!\/)[^?#]*$/.test(path) && path.length <= 200 && !/^\/(?:owner|api|contact-health)(?:\/|$)/i.test(path);
}

export function eligibleCaptureField(field) {
  if (!field || field.disabled || field.readOnly || field.excluded) return false;
  if (!['INPUT', 'TEXTAREA'].includes(String(field.tagName).toUpperCase())) return false;
  if (String(field.tagName).toUpperCase() === 'INPUT' && !['text', 'email', 'tel', 'url', 'search', ''].includes(String(field.type || '').toLowerCase())) return false;
  if (SENSITIVE.test([field.id, field.name, field.autocomplete, field.label].filter(Boolean).join(' '))) return false;
  // These are generated outputs, not volunteered visitor statements.
  return field.id !== 'cg-next-steps';
}

export function explicitIdentifierField(field) {
  const description = [field.id, field.name, field.label, field.autocomplete].filter(Boolean).join(' ');
  return !/service[-_\s]+name/i.test(description) && /(?:^|[-_\s])(?:name|company|phone|email|address)(?:[-_\s]|$)|\b(?:your|full|first|last|business)\s+name\b/i.test(description);
}

export function contactCandidate(fieldName, value, labelledIdentifier = false) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length < 2) return null;
  // Bulk lists remain local even if pasted into an otherwise eligible field.
  const rows = text.split(/\r?\n/).filter(row => row.trim());
  if ((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).length > 5) return null;
  if (rows.length >= 2 && rows.filter(row => /[,;\t]/.test(row)).length === rows.length &&
      (rows.length >= 3 || /(?:name|email|phone|company|address)[,;\t]/i.test(rows[0]))) return null;
  const limited = text.slice(0, 8000);
  return DIRECT_FIELDS.has(fieldName) || labelledIdentifier === true || EMAIL.test(limited) || PHONE.test(limited) || SELF_DESCRIPTION.test(limited) ? limited : null;
}

export function visitorPayload({ visitorId, page, fieldName, value, inquiryReply = false, marketing = false, labelledIdentifier = false }) {
  if (!UUID.test(visitorId || '') || !publicCapturePage(page)) return null;
  const name = String(fieldName || '').slice(0, 120);
  const candidate = contactCandidate(name, value, labelledIdentifier);
  if (!candidate) return null;
  return { visitorId, page, fieldName: name, value: candidate, noticeVersion: VISITOR_NOTICE_VERSION,
    signals: { collection: 'notice-shown', inquiryReply: inquiryReply === true, marketing: marketing === true } };
}

export function recentCaptureAttempts(attempts, now = Date.now()) {
  return Array.isArray(attempts) ? attempts.filter(time => Number.isFinite(time) && time > now - HOUR && time <= now) : [];
}

export function installVisitorContact(win = window, doc = document) {
  if (!publicCapturePage(win.location.pathname) || doc.getElementById('visitor-contact-notice')) return;
  const keys = { visitor: 'legacyai_visitor_v1', stopped: 'legacyai_visitor_capture_stopped_v1', attempts: 'legacyai_visitor_capture_attempts_v1' };
  const read = key => { try { return win.localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { win.localStorage.setItem(key, value); return true; } catch { return false; } };
  let stopped = read(keys.stopped) === 'true', memoryId = null, timer = null, lastField = null, failed = false;
  let attempts; try { attempts = recentCaptureAttempts(JSON.parse(read(keys.attempts))); } catch { attempts = []; }
  const pending = new Map(), attempted = new Set(), controllers = new Set(), notices = new Set(), scopes = new WeakMap(), lastByContext = new Map();
  let touched = new WeakSet();
  const isGPC = () => win.navigator.globalPrivacyControl === true;
  const blocked = () => stopped || isGPC() || !publicCapturePage(win.location.pathname);

  function stopPending() {
    if (timer) win.clearTimeout(timer); timer = null; pending.clear();
    controllers.forEach(controller => controller.abort()); controllers.clear();
    touched = new WeakSet(); lastField = null; lastByContext.clear();
  }
  function refreshNotices() {
    notices.forEach(notice => {
      const text = notice.querySelector('.vc-text'), button = notice.querySelector('.vc-toggle');
      text.textContent = isGPC()
        ? 'Automatic detail saving is off because your browser requests it. Sending an inquiry is still your choice.'
        : stopped ? 'Automatic detail saving is off. Sending an inquiry is still your choice. Stopping does not remove details saved earlier.'
          : 'Contact and business details entered here may be saved, including unfinished forms, to help us understand your needs. Follow-up and marketing require your separate permission.';
      button.textContent = blocked() ? 'Allow future detail saving' : 'Stop future detail saving';
      button.disabled = isGPC();
      const status = notice.querySelector('.vc-state');
      status.textContent = !blocked() && failed ? 'Detail saving is temporarily unavailable. Your forms still work.' : '';
    });
  }
  function makeNotice(id, compact = false) {
    const notice = doc.createElement('aside'); notice.className = `vc-notice${compact ? ' vc-inline' : ''}`; if (id) notice.id = id;
    notice.setAttribute('aria-label', 'Visitor detail saving');
    const text = doc.createElement('p'); text.className = 'vc-text';
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'vc-toggle';
    const status = doc.createElement('span'); status.className = 'vc-state'; status.setAttribute('role', 'status');
    button.addEventListener('click', () => {
      if (isGPC()) return;
      stopped = !stopped; const persisted = write(keys.stopped, String(stopped));
      if (stopped) stopPending();
      refreshNotices();
      if (!persisted) status.textContent = 'This choice applies to this page; browser storage is unavailable.';
    });
    notice.append(text, button, status); notices.add(notice); refreshNotices(); return notice;
  }
  doc.body.append(makeNotice('visitor-contact-notice'));

  function descriptor(field) {
    const labels = field.labels ? [...field.labels].map(label => label.textContent).join(' ') : '';
    return { tagName: field.tagName, type: field.type, id: field.id, name: field.name, autocomplete: field.autocomplete,
      label: `${field.getAttribute?.('aria-label') || ''} ${labels}`, disabled: field.disabled, readOnly: field.readOnly,
      excluded: !!field.closest?.('[data-no-visitor-capture],[data-visitor-capture="off"],[data-local-only],[data-private],.ch-panel,.vc-notice') ||
        !!field.form?.querySelector('input[type="password"],input[type="file"],input[autocomplete^="cc-"]') };
  }
  function eligible(field) { return eligibleCaptureField(descriptor(field)); }
  function scopeFor(field) { return field.closest('.cg-panel') || field.closest('form,[data-visitor-contact-scope],#boardInputBlock') || field.parentElement; }
  function noticeFor(field) {
    if (!eligible(field)) return null;
    const scope = scopeFor(field); if (!scope) return null;
    if (!scopes.has(scope)) { const notice = makeNotice('', true); scope.prepend(notice); scopes.set(scope, notice); }
    return scopes.get(scope);
  }
  function inspectFields(container = doc) {
    container.querySelectorAll('input,textarea').forEach(field => { if (eligible(field)) noticeFor(field); });
  }
  inspectFields();
  const observer = new win.MutationObserver(records => {
    if (records.some(record => [...record.addedNodes].some(item => item.nodeType === 1 && !item.closest?.('.vc-notice')))) inspectFields();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  function shown(field) {
    const notice = noticeFor(field);
    return !!notice && notice.getClientRects().length > 0 && field.getClientRects().length > 0;
  }
  function visitorId() {
    const stored = read(keys.visitor);
    if (UUID.test(stored || '')) return stored;
    if (!memoryId) { memoryId = win.crypto.randomUUID(); write(keys.visitor, memoryId); }
    return memoryId;
  }
  const contextFor = field => field.closest('dialog') || doc;
  function draftSignals(field) {
    const context = contextFor(field);
    return {
      inquiryReply: ((context !== doc && context.querySelector('#lg-confirm,#sg-confirm,#cg-confirm')) || doc.getElementById('cg-confirm'))?.checked === true,
      marketing: ((context !== doc && context.querySelector('#lg-marketing,#sg-marketing,#cg-marketing')) || doc.getElementById('cg-marketing'))?.checked === true
    };
  }
  function enqueue(field) {
    if (blocked() || !eligible(field) || !touched.has(field) || !shown(field)) return;
    const fieldName = field.id || field.name || '';
    const labelledIdentifier = explicitIdentifierField(descriptor(field));
    if (!contactCandidate(fieldName, field.value, labelledIdentifier)) return;
    const payload = visitorPayload({ visitorId: visitorId(), page: win.location.pathname, fieldName, value: field.value,
      labelledIdentifier, ...draftSignals(field) });
    if (!payload) return;
    const signature = JSON.stringify(payload);
    if (attempted.has(signature) || pending.get(field)?.signature === signature) return;
    pending.set(field, { payload, signature }); lastField = field; lastByContext.set(contextFor(field), field);
    if (!timer) timer = win.setTimeout(flush, 700);
  }
  function flush() {
    if (timer) win.clearTimeout(timer); timer = null;
    if (blocked()) { stopPending(); return; }
    attempts = recentCaptureAttempts(attempts);
    let storedAttempts; try { storedAttempts = recentCaptureAttempts(JSON.parse(read(keys.attempts))); } catch { storedAttempts = []; }
    if (storedAttempts.length > attempts.length) attempts = storedAttempts;
    let bytes = 0;
    for (const [field, item] of pending) {
      if (attempts.length >= CAPTURE_LIMIT) { pending.clear(); failed = true; refreshNotices(); break; }
      const size = new TextEncoder().encode(item.signature).byteLength;
      if (bytes + size > 48000) { timer = win.setTimeout(flush, 1200); break; }
      pending.delete(field); bytes += size; attempted.add(item.signature);
      attempts.push(Date.now()); write(keys.attempts, JSON.stringify(attempts));
      const controller = new win.AbortController(); controllers.add(controller);
      const timeout = win.setTimeout(() => controller.abort(), 12000);
      // No waiting on the form, no transcript store, no automatic retry loop.
      win.fetch('/api/visitor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: item.signature, keepalive: true, signal: controller.signal })
        .then(response => { if (!response.ok) { failed = true; if (response.status === 429) pending.clear(); } })
        .catch(() => { if (!blocked()) failed = true; })
        .finally(() => { win.clearTimeout(timeout); controllers.delete(controller); refreshNotices(); });
    }
  }

  // Input only marks a visitor edit; no value is sent on individual keystrokes.
  doc.addEventListener('input', event => { if (event.isTrusted && !blocked() && eligible(event.target) && shown(event.target)) touched.add(event.target); }, true);
  doc.addEventListener('focusin', event => { if (eligible(event.target)) noticeFor(event.target); }, true);
  doc.addEventListener('change', event => {
    if (!event.isTrusted || blocked()) return;
    if (['cg-confirm', 'cg-marketing', 'lg-confirm', 'lg-marketing', 'sg-confirm', 'sg-marketing'].includes(event.target.id)) {
      const field = lastByContext.get(contextFor(event.target)); if (field) enqueue(field); return;
    }
    if (eligible(event.target) && shown(event.target)) touched.add(event.target);
    enqueue(event.target);
  }, true);
  doc.addEventListener('focusout', event => { if (event.isTrusted) enqueue(event.target); }, true);
  doc.addEventListener('submit', event => {
    if (!event.isTrusted || blocked()) return;
    event.target.querySelectorAll('input,textarea').forEach(enqueue);
    if (lastField) enqueue(lastField); flush();
  }, true);
  win.addEventListener('storage', event => { if (event.key === keys.stopped) { stopped = event.newValue === 'true'; if (stopped) stopPending(); refreshNotices(); } });
  win.addEventListener('pagehide', () => { if (!blocked()) flush(); });
  doc.addEventListener('visibilitychange', () => { if (isGPC()) { stopPending(); refreshNotices(); } });
  return { stop() { stopped = true; write(keys.stopped, 'true'); stopPending(); refreshNotices(); }, disconnect() { stopPending(); observer.disconnect(); } };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => installVisitorContact(), { once: true });
  else installVisitorContact();
}
