import { DAY_NAMES } from '../booking/core.js';
import { buildProfile, offeredSlots, callRecord } from './core.js';
import { requestLead } from '../lead-gate.js';

const $ = id => document.getElementById(id);
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
let receipt = null, call = null, busy = false, recognizer = null, listening = false;

for (const [index, name] of DAY_NAMES.entries()) {
  const label = node('label'), box = document.createElement('input');
  box.type = 'checkbox'; box.name = 'day'; box.value = String(index); box.checked = index >= 1 && index <= 5;
  label.append(box, name.slice(0, 3)); label.title = name; $('days').append(label);
}
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function status(message) { $('status').textContent = message; }
function live(state, label) { $('live').dataset.state = state; $('live').textContent = label; }

function rules() {
  return { days: [...document.querySelectorAll('input[name=day]:checked')].map(b => Number(b.value)), open: $('open').value, close: $('close').value, length: Number($('length').value), noticeHours: Number($('notice').value), horizonDays: 21 };
}
function currentSlots() { return $('messages-only').checked ? [] : offeredSlots(rules()); }
function updateSlots() {
  $('booking-rules').hidden = $('messages-only').checked;
  try {
    const slots = currentSlots();
    $('slot-summary').textContent = $('messages-only').checked ? 'The receptionist will take a message and promise a callback.' : slots.length ? `It can offer ${slots.length} open times, starting ${slots[0].label}.` : 'No open times fit these settings. The receptionist will take messages instead.';
  } catch (e) { $('slot-summary').textContent = e.message; }
}
for (const id of ['open', 'close', 'length', 'notice', 'messages-only']) $(id).addEventListener('input', updateSlots);
$('days').addEventListener('change', updateSlots);
updateSlots();

function profile() {
  return buildProfile({ business: $('business').value, trade: $('trade').value, hours: $('hours').value, area: $('area').value, services: $('services').value, notes: $('notes').value, languages: [...document.querySelectorAll('input[name=language]:checked')].map(b => b.value) });
}

function renderOwner() {
  const turn = call?.turn;
  $('o-name').textContent = turn?.caller.name || (call?.messages.length ? 'Not given yet' : 'Listening…');
  $('o-callback').textContent = turn?.caller.callback || '—';
  $('o-reason').textContent = turn?.caller.reason || '—';
  const slot = turn?.booking.slotId && call.slots.find(s => s.id === turn.booking.slotId);
  $('o-booking').textContent = slot ? `${slot.label} — ${turn.booking.status === 'held' ? 'held for you to confirm' : 'offered, not yet accepted'}` : 'None yet';
  $('o-follow').textContent = turn?.followUp || '—';
  $('download').disabled = !call?.messages.length;
}
function addLine(role, content) {
  const item = node('li', undefined, role === 'caller' ? 'tl-caller' : 'tl-receptionist');
  item.append(node('span', role === 'caller' ? 'You (caller)' : 'Receptionist', 'tl-who'), node('span', content));
  $('log').append(item); $('log').scrollTop = $('log').scrollHeight;
}

function speak(text, language) {
  return new Promise(resolve => {
    if (!synth || !$('speak').checked) return resolve();
    try {
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text), lang = language === 'es' ? 'es' : 'en';
      utterance.lang = lang === 'es' ? 'es-US' : 'en-US';
      const voice = synth.getVoices().find(v => v.lang?.toLowerCase().startsWith(lang + '-us')) || synth.getVoices().find(v => v.lang?.toLowerCase().startsWith(lang));
      if (voice) utterance.voice = voice;
      utterance.onend = utterance.onerror = () => resolve();
      live('speaking', 'Receptionist speaking…'); synth.speak(utterance);
    } catch { resolve(); } // Speech output is optional; the transcript already shows the reply.
  });
}

async function turn() {
  if (!call || busy) return;
  busy = true; $('send').disabled = true; $('talk').disabled = true; error(); live('thinking', 'Receptionist answering…');
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 40000);
  try {
    const response = await fetch('/api/receptionist', { method: 'POST', signal: controller.signal, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Legacy-Inquiry': receipt.id }, body: JSON.stringify({ profile: call.profile, slots: call.slots, messages: call.messages }) });
    let value; try { value = await response.json(); } catch { throw new Error('The receptionist did not return a readable reply. Please try again.'); }
    if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : 'The receptionist could not answer. Please try again.');
    if (typeof value?.reply !== 'string' || !value.caller || !value.booking) throw new Error('The receptionist returned an incomplete reply. Please try again.');
    call.turn = value; call.language = value.language; call.messages.push({ role: 'receptionist', content: value.reply });
    addLine('receptionist', value.reply); renderOwner();
    await speak(value.reply, value.language);
    if (value.endCall) return finish('The caller said goodbye. Here is what you would receive.');
    live('idle', 'Your turn to speak');
  } catch (e) {
    // Undo an unanswered caller line so a retry does not send it twice.
    if (call?.messages.at(-1)?.role === 'caller') { const last = call.messages.pop(); $('say').value = last.content; $('log').lastElementChild?.remove(); }
    error(e.name === 'AbortError' ? 'The receptionist took too long to answer. Please try again.' : e.message); live('idle', 'Waiting');
    if (!call?.messages.length) $('start').hidden = false;
  } finally {
    clearTimeout(timeout); busy = false;
    if (call) { $('send').disabled = false; $('talk').disabled = false; }
  }
}

function say(text) {
  const content = text.trim();
  if (!content || !call || busy) return;
  if (content.length > 1200) return error('Keep each thing you say under 1,200 characters.');
  call.messages.push({ role: 'caller', content }); addLine('caller', content); $('say').value = ''; turn();
}
$('say-form').addEventListener('submit', event => { event.preventDefault(); say($('say').value); });
$('say').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); say($('say').value); } });

// Voice input is an enhancement: when recognition is missing or blocked, typing continues.
if (Recognition) {
  $('talk').hidden = false;
  $('talk').addEventListener('click', () => {
    if (listening) { recognizer?.stop(); return; }
    if (!call || busy) return;
    synth?.cancel();
    recognizer = new Recognition();
    recognizer.lang = call.language === 'es' ? 'es-US' : 'en-US';
    recognizer.interimResults = true; recognizer.maxAlternatives = 1; recognizer.continuous = false;
    let finalText = '';
    recognizer.onresult = event => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) (event.results[i].isFinal ? (finalText += event.results[i][0].transcript) : (interim += event.results[i][0].transcript));
      $('say').value = (finalText + interim).trim();
    };
    recognizer.onerror = event => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') { $('talk').hidden = true; error('Microphone access is off for this page. You can keep typing.'); }
      else if (event.error !== 'no-speech' && event.error !== 'aborted') error('Voice input stopped. You can try again or type instead.');
    };
    recognizer.onend = () => { listening = false; $('talk').setAttribute('aria-pressed', 'false'); $('talk').textContent = 'Talk with your voice'; if (!busy) live('idle', 'Your turn to speak'); if (finalText.trim()) say(finalText); };
    try { recognizer.start(); listening = true; $('talk').setAttribute('aria-pressed', 'true'); $('talk').textContent = 'Stop listening'; live('listening', `Listening${recognizer.lang.startsWith('es') ? ' (español)' : ''}…`); }
    catch { listening = false; error('Voice input could not start. You can type instead.'); }
  });
}
if (!synth) { $('speak').checked = false; $('speak').closest('label').hidden = true; }

$('start').addEventListener('click', async () => {
  if (busy) return;
  error();
  let details, slots;
  try { details = profile(); slots = currentSlots(); } catch (e) { error(e.message); return; }
  $('start').disabled = true;
  try {
    receipt = receipt || await requestLead({ key: 'receptionist-test-line', purpose: 'AI receptionist inquiry', serviceIds: ['the-receptionist-who-never-calls-in', 'the-live-booking-calendar'], title: 'Where should Douglas follow up?', intro: 'Tell Douglas about the calls your business misses or struggles with. Once your inquiry is received, your test line opens here.', request: '', localNote: 'Only these contact details and your request are sent to Douglas. Your test call is not saved, and nothing is booked or sent to a customer.' });
  } catch (e) { error(e.message); }
  $('start').disabled = false;
  if (!receipt) { status('Send an inquiry when you are ready to place a test call.'); return; }
  synth?.cancel(); $('log').replaceChildren(); $('download').onclick = null;
  call = { profile: details, slots, messages: [], turn: null, language: details.languages[0], startedAt: new Date() };
  $('call').hidden = false; $('start').hidden = true; $('hang-up').hidden = false; $('start').textContent = 'Start a new test call';
  status(`Inquiry received (${receipt.id}). Your test line is ringing.`); renderOwner(); $('call-heading').focus();
  await turn();
});

function finish(message) {
  if (!call) return;
  recognizer?.abort(); synth?.cancel();
  call.endedAt = new Date(); status(message); live('idle', 'Call ended');
  $('send').disabled = true; $('talk').disabled = true; $('hang-up').hidden = true; $('start').hidden = false;
  const record = callRecord(call); $('download').onclick = () => save(record); $('download').disabled = !call.messages.length;
  call = null;
}
$('hang-up').addEventListener('click', () => finish('You hung up. Here is what you would receive.'));
function save(text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), link = node('a');
  link.href = url; link.download = 'legacy-ai-test-call.txt'; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('download').addEventListener('click', () => { if (call) save(callRecord(call)); });
