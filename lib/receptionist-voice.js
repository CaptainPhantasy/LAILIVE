// Server-only voice generation. The browser receives audio, never credentials.
const selectedVoiceId = '5u41aNhyCU6hXOcjPPv0';

export function createReceptionistSpeech({ env = process.env, fetcher = fetch } = {}) {
  return async (reply, language) => {
    const voiceId = env.RECEPTIONIST_VOICE_ID || selectedVoiceId;
    if (!env.ELEVENLABS_API_KEY || !voiceId || !/^[A-Za-z0-9_-]{1,100}$/.test(voiceId)) {
      throw new Error('Receptionist voice is not configured');
    }
    const response = await fetcher(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: reply, model_id: 'eleven_multilingual_v2', language_code: language }),
      signal: AbortSignal.timeout(10000),
    });
    // Do not expose provider response bodies, which can contain account details.
    if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/')) throw new Error('Receptionist voice unavailable');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 2000000) throw new Error('Invalid receptionist audio');
    return { mimeType: 'audio/mpeg', base64: bytes.toString('base64') };
  };
}
