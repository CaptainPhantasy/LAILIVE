import { requestLead } from '/lead-gate.js';

const $ = id => document.getElementById(id);
const labels = { summary: 'Summary', work_requested: 'Reason for the visit', observations: 'Findings & observations', work_completed: 'Work completed', recommendations: 'Recommendations', next_steps: 'Next steps' };
const metadataLabels = { customer: 'Customer', location: 'Location', jobDate: 'Visit date', preparedBy: 'Prepared by' };
let currentReport = null, generatedNote = '', working = false, recognition = null, recording = false, starting = false, ticker, stopTimer, speechStart = 0, speechFailed = false;
const show = (id, message) => { $(id).textContent = message; $(id).hidden = !message; };
const scrollToResult = () => $('report-result').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });

function refreshCount() { $('note-count').textContent = `${$('notes').value.length.toLocaleString()} / 6,000`; }
function updateNoteState() {
  refreshCount();
  if (currentReport && $('notes').value.trim() !== generatedNote) {
    $('download').disabled = true;
    show('download-status', 'Your notes changed. Choose “Make my report” to include the new details.');
  } else if (currentReport && !working) {
    $('download').disabled = false;
    show('download-status', '');
  }
}
$('notes').addEventListener('input', updateNoteState);

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SpeechRecognition) {
  $('dictate').hidden = true;
  $('speech-status').textContent = 'Type your notes below, or use the microphone on your phone’s keyboard to dictate.';
} else {
  $('dictate').addEventListener('click', () => {
    if (working || starting) return;
    if (recording) { recognition.stop(); $('dictate-label').textContent = 'Finishing…'; return; }
    if ($('notes').value.length >= 6000) { $('speech-status').textContent = 'Your notes are full. Shorten them before adding more dictation.'; return; }
    recognition = new SpeechRecognition();
    recognition.lang = 'en-US'; recognition.continuous = true; recognition.interimResults = true;
    starting = true; speechFailed = false;
    $('dictate-label').textContent = 'Opening microphone…';
    $('speech-status').textContent = 'Allow microphone access when your browser asks.';
    recognition.onstart = () => {
      starting = false; recording = true; speechStart = Date.now();
      $('dictate').setAttribute('aria-pressed', 'true'); $('dictate-label').textContent = 'Stop dictation';
      $('speech-status').textContent = 'Listening. Speak naturally, then choose “Stop dictation.”';
      $('notes').readOnly = true; $('example').disabled = true;
      ticker = setInterval(() => { const seconds = Math.floor((Date.now() - speechStart) / 1000); $('timer').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }, 1000);
      stopTimer = setTimeout(() => recognition.stop(), 120000);
    };
    recognition.onresult = event => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const words = event.results[i][0].transcript.trim();
        if (event.results[i].isFinal && words) {
          const sentence = /[.!?]$/.test(words) ? words : `${words}.`;
          $('notes').value = `${$('notes').value.trim()} ${sentence}`.trim().slice(0, 6000);
        }
        else interim += ` ${words}`;
      }
      show('interim', interim.trim()); updateNoteState();
      if ($('notes').value.length >= 6000) recognition.stop();
    };
    recognition.onerror = event => {
      speechFailed = true;
      const messages = {
        'not-allowed': 'Microphone access was declined. You can allow it in your browser, type below, or use your phone keyboard’s microphone.',
        'audio-capture': 'No microphone was available. You can type your job notes below.',
        'no-speech': 'No speech was picked up. Try again, or type your notes below.',
        network: 'The speech connection was interrupted. Your captured notes are still below; type the rest or try dictation again.',
      };
      $('speech-status').textContent = messages[event.error] || 'Dictation stopped. Your captured notes are still below; you can keep typing.';
    };
    recognition.onend = () => {
      clearInterval(ticker); clearTimeout(stopTimer); recording = false; starting = false;
      $('dictate').setAttribute('aria-pressed', 'false'); $('dictate-label').textContent = $('notes').value ? 'Add more by voice' : 'Start talking';
      $('timer').textContent = ''; show('interim', ''); $('notes').readOnly = false; $('example').disabled = false;
      if (!speechFailed) $('speech-status').textContent = $('notes').value ? 'Dictation paused. Check your notes, then make your report.' : 'No words captured yet. Try again or type your notes below.';
      refreshCount();
    };
    try { recognition.start(); } catch {
      starting = false; $('dictate-label').textContent = 'Start talking';
      $('speech-status').textContent = 'The microphone could not start. Try again, or type your notes below.';
    }
  });
}

$('example').addEventListener('click', () => {
  if ($('notes').value.trim()) { $('notes').focus(); show('generation-status', 'Keep your own notes, or clear the field first to try the sample.'); return; }
  $('notes').value = 'I visited 214 Oak Street for Maria López. She reported that the kitchen tap kept dripping. I found a worn washer and no visible damage to the tap body. I replaced the washer, reassembled the tap, and checked it five times. No dripping during the final check. I advised Maria to call if the leak returns. No further work was scheduled.';
  $('speech-status').textContent = 'Sample job note loaded. Edit it or choose “Make my report” to try it.';
  updateNoteState(); $('notes').focus();
});

async function post(url, body) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 55000);
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) {
      let message;
      try { message = (await response.json()).error; } catch { /* Safe text below for an unreadable response. */ }
      throw new Error(typeof message === 'string' ? message : 'The service could not finish that request. Please try again.');
    }
    return response;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The connection took too long. Your notes are still here; please try again.');
    throw error;
  } finally { clearTimeout(timer); }
}

function setWorking(value) {
  working = value;
  for (const id of ['generate', 'dictate', 'example', 'notes']) $(id).disabled = value;
  if (currentReport) $('download').disabled = value;
  $('generate').replaceChildren(document.createTextNode(value ? 'Organizing your report…' : 'Make my report'), Object.assign(document.createElement('span'), { textContent: value ? '…' : '↗' }));
}

function fitTextArea(area) { area.style.height = 'auto'; area.style.height = `${Math.max(55, area.scrollHeight + 2)}px`; }
function addSection(kind, content = '') {
  if (!labels[kind] || $(`section-${kind}`)) return;
  const section = document.createElement('section'); section.className = 'report-section';
  const label = document.createElement('label'); label.htmlFor = `section-${kind}`; label.textContent = labels[kind];
  const textarea = document.createElement('textarea'); textarea.id = `section-${kind}`; textarea.dataset.kind = kind; textarea.maxLength = 6000; textarea.rows = 2; textarea.value = content;
  textarea.addEventListener('input', () => fitTextArea(textarea));
  section.append(label, textarea); $('report-sections').append(section);
  requestAnimationFrame(() => fitTextArea(textarea)); refreshSectionChoice();
}
function refreshSectionChoice() {
  const select = $('section-choice'); select.replaceChildren(Object.assign(document.createElement('option'), { textContent: 'Add a section…', value: '' }));
  for (const [kind, label] of Object.entries(labels)) if (!$(`section-${kind}`)) select.append(Object.assign(document.createElement('option'), { textContent: label, value: kind }));
  select.parentElement.hidden = select.options.length === 1;
}
$('section-add').addEventListener('click', () => { const kind = $('section-choice').value; if (kind) { addSection(kind); $(`section-${kind}`).focus(); } });

function showReport(report) {
  currentReport = report;
  $('report-title').value = report.title;
  $('metadata').replaceChildren(); $('metadata-extra').replaceChildren(); $('report-sections').replaceChildren();
  for (const [key, name] of Object.entries(metadataLabels)) {
    const label = document.createElement('label'); label.textContent = name;
    const input = document.createElement('input'); input.id = `report-${key}`; input.value = report[key] || ''; input.maxLength = 250; input.placeholder = 'Add if needed';
    label.append(input); $(report[key] ? 'metadata' : 'metadata-extra').append(label);
  }
  $('add-details').hidden = !$('metadata-extra').children.length;
  $('add-details').open = false;
  for (const section of report.sections) addSection(section.kind, section.content);
  $('empty-report').hidden = true; $('report-result').hidden = false;
  requestAnimationFrame(() => { document.querySelectorAll('.report-section textarea').forEach(fitTextArea); scrollToResult(); });
  $('report-title').focus({ preventScroll: true });
}
function editedReport() {
  const title = $('report-title').value.trim();
  if (!title) throw new Error('Give your report a title before downloading.');
  const sections = [...document.querySelectorAll('.report-section textarea')].map(area => ({ kind: area.dataset.kind, content: area.value.trim() })).filter(section => section.content);
  if (!sections.length) throw new Error('Add some report details before downloading.');
  return { title, ...Object.fromEntries(Object.keys(metadataLabels).map(key => [key, $(`report-${key}`).value.trim()])), sections };
}

$('report-form').addEventListener('submit', async event => {
  event.preventDefault(); if (working) return;
  if (recording || starting) { $('speech-status').textContent = 'Stop dictation and check your notes before making the report.'; $('dictate').focus(); return; }
  const transcript = $('notes').value.trim();
  if (transcript.length < 35) { show('error', 'Add a little more about the job: what you found, what you did, or what comes next.'); return; }
  show('error', ''); show('download-error', ''); show('generation-status', 'Organizing the details you supplied…'); setWorking(true);
  try {
    const value = await (await post('/api/voice-report', { transcript })).json();
    if (!value?.report?.sections?.length) throw new Error('A complete report did not arrive. Your notes are still here; please try again.');
    generatedNote = transcript; showReport(value.report);
    show('generation-status', 'Your report is ready to review.'); show('download-status', '');
  } catch (error) { show('generation-status', ''); show('error', error.message || 'The report could not be completed. Please try again.'); }
  finally { setWorking(false); updateNoteState(); }
});

$('download').addEventListener('click', async () => {
  if (!currentReport || working) return;
  if ($('notes').value.trim() !== generatedNote) { updateNoteState(); return; }
  show('download-error', ''); $('download').disabled = true;
  show('download-status', 'Preparing your PDF…');
  try {
    const report = editedReport();
    const response = await post('/api/voice-report-pdf', report);
    if (!response.headers.get('content-type')?.includes('application/pdf')) throw new Error('A readable PDF did not arrive. Please try again.');
    const blob = await response.blob();
    if (!blob.size) throw new Error('The PDF was empty. Please try again.');
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'Job-report.pdf'; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    show('download-status', 'Your PDF is ready. Check your browser’s downloads.');
  } catch (error) { show('download-status', ''); show('download-error', error.message || 'The PDF could not be prepared. Please try again.'); }
  finally { $('download').disabled = $('notes').value.trim() !== generatedNote; }
});

$('discuss').addEventListener('click', async () => {
  show('discuss-status', '');
  try {
    const receipt = await requestLead({
      key: 'voice-report-enquiry', title: 'Put voice-to-report to work.',
      purpose: 'Voice-to-report service inquiry',
      intro: 'Tell Douglas where to reach you. Your job notes and report stay out of this inquiry.',
      serviceIds: ['the-report-writer', 'the-talk-to-type-field-tool'],
      request: currentReport ? 'I tried voice-to-report and would like it for my business. Please contact me about setup and pricing.' : 'I would like to discuss voice-to-report for my business.',
      localNote: 'Only the contact details and request you approve here are submitted. Your report and job notes are not included.',
    });
    if (receipt) show('discuss-status', 'Your request was received. Douglas has your contact details.');
  } catch (error) { show('discuss-status', error.message || 'Please call Darla or email Douglas to discuss your reports.'); }
});
window.addEventListener('pagehide', () => { if (recording || starting) recognition?.abort(); clearInterval(ticker); clearTimeout(stopTimer); });
refreshCount();
