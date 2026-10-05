// Local-only boundary replacement. It is never copied into the deployed site.
// No microphone, provider network, real token or speech synthesis is used.
function observable() {
  const listeners = new Set();
  return { subscribe(fn) { listeners.add(fn); return { unsubscribe() { listeners.delete(fn); } }; }, emit(value) { for (const fn of [...listeners]) fn(value); } };
}
function report(text) {
  const line = document.createElement('li'); line.textContent = text;
  document.getElementById('dryrun-progress').append(line);
}
export class StaticCredentialProvider { constructor(value) { this.value = value; } }
export class SignalWire {
  constructor(credentials) {
    if (credentials.value.token !== 'synthetic-guest-no-provider') throw new Error('Only synthetic access is accepted.');
  }
  async dial(destination, options) {
    if (destination !== '/private/legacyai-receptionist-preview' || !options.audio || options.video) throw new Error('Invalid simulated destination.');
    const events = observable(), status$ = observable(), remoteStream$ = observable();
    const audioContext = new AudioContext(), oscillator = audioContext.createOscillator(), gain = audioContext.createGain(), output = audioContext.createMediaStreamDestination();
    oscillator.frequency.value = 440; gain.gain.value = 0.025;
    oscillator.connect(gain); gain.connect(output); oscillator.start(); await audioContext.resume();
    let session = options.userVariables.receptionist_session, ended = false;
    const callId = crypto.randomUUID();
    const end = () => {
      if (ended) return;
      ended = true; document.removeEventListener('dryrun-speech', speech);
      oscillator.stop(); output.stream.getTracks().forEach(track => track.stop()); audioContext.close();
      report('Clean end: local stream stopped; simulated call disconnected.'); status$.emit('disconnected');
    };
    const callback = async transcript => {
      const response = await fetch('/__dryrun/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session, callId, transcript }) });
      const definition = await response.json();
      if (ended) return;
      if (!response.ok) { status$.emit('failed'); end(); throw new Error('Simulated callback rejected.'); }
      const main = definition.sections.main, turnEvent = main.find(item => item.user_event)?.user_event.event;
      if (turnEvent) events.emit({ params: { event: turnEvent } });
      const spoken = main.find(item => item.prompt)?.prompt.play || main.find(item => item.play)?.play.url;
      report(`${transcript ? 'Checked spoken reply' : 'Greeting delivered'}: ${spoken?.replace(/^say:/, '')}`);
      session = main.find(item => item.transfer)?.transfer.params.session;
      if (main.some(item => item.hangup)) end();
    };
    const speech = async event => {
      const button = document.getElementById('dryrun-send'); button.disabled = true;
      report(`Simulated speech transcript: ${event.detail}`);
      try { await callback(event.detail); } catch (error) { report(error.message); } finally { button.disabled = ended; }
    };
    document.addEventListener('dryrun-speech', speech);
    this.close = end;
    const call = { status$, remoteStream$, subscribe: type => { if (type !== 'user_event') throw new Error('Unexpected event'); return events; }, hangup: async () => end() };
    setTimeout(async () => {
      if (ended) return;
      status$.emit('connected'); remoteStream$.emit(output.stream);
      report('Simulated connection active. Local tone represents the remote audio stream.');
      const audio = document.getElementById('voice-audio');
      audio.addEventListener('playing', () => report('Audio delivery verified: page audio player is playing the local stream.'), { once: true });
      try { await callback(); } catch (error) { report(error.message); }
    }, 0);
    return call;
  }
  destroy() { this.close?.(); }
}
