import { HttpError } from './concierge/contracts.js';
import { boardPolicy } from './board-policy.js';

export function withBoardLead(handler, getStore, { env = process.env, now = Date.now } = {}) {
  return async request => {
    if (request.method !== 'POST') return handler(request);
    const headers = { 'Cache-Control': 'no-store' };
    let store, id, claim;
    const finish = async completed => {
      if (!claim) return;
      const current = claim;
      claim = undefined;
      await store.finishBoardSession(id, current, completed);
    };
    try {
      if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) throw new HttpError(403, 'Use the Board from this website.');
      id = request.headers.get('x-legacy-inquiry');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) throw new HttpError(403, 'Add your contact details so Douglas can understand your question.');
      store = getStore();
      const inquiry = await store.getInquiry(id);
      const choices = inquiry?.consent?.filter(c => c.purpose === 'inquiry-reply') || [];
      if (!inquiry || choices.at(-1)?.choice !== 'granted') throw new HttpError(403, 'Please review the contact step before asking the Board.');
      const time = now(), date = new Date(time), hour = date.toISOString().slice(0, 13), day = date.toISOString().slice(0, 10);
      claim = await store.claimBoardSession(id, boardPolicy(env, time).repeatSessions, time);
      const expiresAt = new Date(time + 86400000).toISOString();
      await store.consumeLimits([{ key: `board:${hour}:${id}`, limit: 4, expiresAt }, { key: `board:${day}`, limit: 20, expiresAt }]);
      const response = await handler(request);
      if (!response.ok || !response.body) { await finish(false); return response; }
      const reader = response.body.getReader();
      let cancelled = false;
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (cancelled) return;
            if (next.done) { await finish(true); reader.releaseLock(); controller.close(); }
            else controller.enqueue(next.value);
          } catch (error) {
            try { await finish(false); } catch { /* Retain the claim until expiry when storage fails. */ }
            if (!cancelled) controller.error(error);
          }
        },
        async cancel(reason) {
          cancelled = true;
          try { await reader.cancel(reason); }
          finally { await finish(false); reader.releaseLock(); }
        },
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      try { await finish(false); } catch { /* A failed store never becomes empty session state. */ }
      return Response.json({ error: error instanceof HttpError ? error.message : 'The contact step could not be verified. Please try again.' }, { status: error instanceof HttpError ? error.status : 503, headers });
    }
  };
}
