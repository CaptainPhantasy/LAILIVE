import { buildTextBacks, smsSegments, checkMessage, gsmSafe } from './core.js';

const $ = id => document.getElementById(id);
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
let messages = [], business = '', receipt = null;

function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function preview(message) { $('preview-from').textContent = `Text from ${business}`; $('preview').textContent = message.text; }

function meter(message, box, warnings) {
  const stats = smsSegments(message.text);
  box.replaceChildren();
  const add = (label, value) => { const span = node('span', `${label} `); span.append(node('strong', value)); box.append(span); };
  add('Characters', String([...message.text].length)); add('Encoding', stats.encoding); add('Billed segments', String(stats.segments));
  warnings.replaceChildren();
  const found = checkMessage(message.text, { business, first: message.first, spanish: message.spanish });
  for (const w of found) warnings.append(node('li', w.message));
  warnings.nextElementSibling.hidden = !found.some(w => w.code === 'encoding');
  warnings.previousElementSibling.hidden = found.length > 0;
}

function renderMessages() {
  const container = $('messages'); container.replaceChildren();
  for (const message of messages) {
    const article = node('article', undefined, 'tl-message'), id = `m-${message.key}`;
    const heading = node('h3', message.label); heading.id = id; article.setAttribute('aria-labelledby', id);
    const label = node('label', 'Message'), area = document.createElement('textarea');
    area.rows = 4; area.maxLength = 1000; area.value = message.text; area.lang = message.spanish ? 'es' : 'en'; label.append(area);
    const stats = node('p', undefined, 'tl-meter'), ok = node('p', 'Looks good: names your business and stays short.', 'tl-ok'), warnings = node('ul', undefined, 'tl-warn');
    const fix = node('button', 'Use plain-text quotes and dashes', 'ch-secondary'); fix.type = 'button';
    fix.addEventListener('click', () => { area.value = message.text = gsmSafe(area.value); meter(message, stats, warnings); preview(message); });
    area.addEventListener('input', () => { message.text = area.value; meter(message, stats, warnings); preview(message); });
    area.addEventListener('focus', () => preview(message));
    article.append(heading, label, stats, ok, warnings, fix); container.append(article);
    meter(message, stats, warnings);
  }
  if (messages[0]) preview(messages[0]);
}

$('write').addEventListener('click', () => {
  error();
  try {
    messages = buildTextBacks({ business: $('business').value, link: $('link').value, hours: $('hours').value, callback: $('callback').value, spanish: $('spanish').checked });
    business = $('business').value.trim();
    renderMessages(); $('results').hidden = false; $('status').textContent = ''; $('messages-heading').focus();
  } catch (e) { error(e.message); }
});

const allText = () => messages.map(m => `${m.label}\n${m.text}\n(${smsSegments(m.text).segments} segment${smsSegments(m.text).segments === 1 ? '' : 's'}, ${smsSegments(m.text).encoding})`).join('\n\n') + '\n';
$('download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([`MISSED-CALL TEXT-BACKS — ${business}\nDrafted on the Legacy AI text-back builder. Nothing has been sent.\n\n${allText()}`], { type: 'text/plain;charset=utf-8' })), link = node('a');
  link.href = url; link.download = 'legacy-ai-text-backs.txt'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('status').textContent = 'Download prepared on this device.';
});
$('copy-all').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(allText()); $('status').textContent = 'All messages copied.'; }
  catch { $('status').textContent = 'Copying is blocked in this browser. Use the download instead.'; }
});

// Optional: the builder works without this; the inquiry only opens a conversation.
$('discuss').addEventListener('click', async () => {
  try {
    const { requestLead } = await import('../lead-gate.js');
    receipt = receipt || await requestLead({ key: 'missed-call-recovery', purpose: 'Missed-call text-back inquiry', serviceIds: ['the-missed-call-recovery', 'the-follow-up-machine'], title: 'Turn missed calls into booked jobs.', intro: 'Tell Douglas roughly how many calls you miss and which phone system you use.', request: '', localNote: 'Only these contact details and your request are sent to Douglas. Your drafted messages stay on this device.' });
    $('discuss-status').textContent = receipt ? `Inquiry received (${receipt.id}). Douglas can reply by email.` : '';
  } catch (e) { $('discuss-status').textContent = e.message; }
});
