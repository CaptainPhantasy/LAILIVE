const start = document.getElementById('start'), hangup = document.getElementById('hang-up');
const status = document.getElementById('status'), error = document.getElementById('error');
const audio = document.getElementById('voice-audio'), consent = document.getElementById('consent');
let active;
function finish(attempt, message) {
  if (active !== attempt) return;
  active = undefined; attempt.controller.abort(); attempt.connection?.stop();
  hangup.hidden = true; status.textContent = message;
}
start.addEventListener('click', async () => {
  if (active || start.disabled) return;
  if (!consent.checked) { error.textContent = 'Review the notice and check the box to start.'; return; }
  start.disabled = true; consent.disabled = true; error.textContent = '';
  const attempt = { controller: new AbortController() }; active = attempt;
  hangup.hidden = false; audio.hidden = false; status.textContent = 'Connecting…';
  try {
    const response = await fetch('/api/receptionist-session', { method: 'POST', credentials: 'same-origin', signal: attempt.controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: true }) });
    const access = await response.json();
    if (!response.ok) throw new Error(access.error || 'Voice access could not be created.');
    if (active !== attempt) return;
    const { startBrowserVoice } = await import('./signalwire-browser.js');
    if (active !== attempt) return;
    const connection = await startBrowserVoice({ access, audio, signal: attempt.controller.signal,
      onError: message => { if (active === attempt) error.textContent = message; },
      onStatus: state => {
        if (active !== attempt) return;
        if (state === 'connected') status.textContent = 'Connected. Speak to the receptionist.';
        else if (['disconnected', 'failed', 'destroyed'].includes(state)) finish(attempt, state === 'failed' ? 'The voice connection failed.' : 'Call ended.');
        else status.textContent = `Call: ${state}`;
      },
    });
    if (active !== attempt) await connection.stop(); else attempt.connection = connection;
  } catch (failure) {
    if (active !== attempt) return;
    error.textContent = failure.name === 'AbortError' ? 'Call cancelled.' : failure.message;
    finish(attempt, 'Voice did not connect.');
  }
});
hangup.addEventListener('click', () => { if (active) finish(active, 'You hung up.'); });
window.addEventListener('pagehide', () => { if (active) finish(active, 'Call ended.'); });
