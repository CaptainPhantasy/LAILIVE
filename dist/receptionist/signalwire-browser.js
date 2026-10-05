import { SignalWire, StaticCredentialProvider } from '@signalwire/js';

// Imported only after the visitor explicitly chooses to start a voice call.
// No project credentials, refresh token, recording or PSTN destination here.
export async function startBrowserVoice({ access, audio, onTurn, onStatus, onError, signal, createClient = credentials => new SignalWire(new StaticCredentialProvider(credentials)) }) {
  const client = createClient({ token: access.token, expiry_at: access.expiresAt * 1000 });
  const subscriptions = [], deadline = Math.min(access.expiresAt * 1000 - Date.now(), (access.maxCallSeconds || 180) * 1000);
  let call, timer, ownedStream, stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true; clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    for (const subscription of subscriptions) subscription.unsubscribe();
    if (ownedStream && audio.srcObject === ownedStream) { audio.pause(); audio.srcObject = null; }
    client.destroy();
    try { await call?.hangup(); } catch { /* closing an already-ended call */ }
  };
  const abort = () => { stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (deadline <= 0 || signal?.aborted) throw new Error('expired');
    timer = setTimeout(() => { stop(); onStatus('disconnected'); }, deadline);
    call = await client.dial(access.destination, { audio: true, video: false, receiveAudio: true, receiveVideo: false, preferredAudioCodecs: ['PCMU'], ...(access.session ? { userVariables: { receptionist_session: access.session } } : {}) });
    if (stopped) { try { await call.hangup(); } catch { /* stopped during dial */ } throw new Error('expired'); }
    subscriptions.push(call.remoteStream$.subscribe(stream => {
      if (!stream || stopped) return;
      ownedStream = stream; audio.srcObject = stream;
      audio.play().catch(() => { if (!stopped) onError('Your browser blocked audio. Use the audio player to hear the call.'); });
    }));
    subscriptions.push(call.status$.subscribe(status => {
      if (stopped) return;
      if (['disconnected', 'failed', 'destroyed'].includes(status)) stop();
      onStatus(status);
    }));
    // The approved integration test must verify the v4 user_event envelope.
    if (onTurn && access.session) subscriptions.push(call.subscribe('user_event').subscribe(value => {
      const event = value?.params?.event || value?.event || value;
      if (!stopped && event?.receptionist?.turn) onTurn(event.receptionist);
    }));
    return { stop };
  } catch {
    await stop();
    throw new Error('The Legacy AI receptionist could not connect. Refresh this page and try again.');
  }
}
