// Exact Google Calendar REST calls through the owner's configured Zapier MCP.
// No model-generated text is accepted as evidence that an event exists.
// Bookings are restricted to this dedicated Legacy AI calendar, never PSI or primary.
export const LEGACY_BOOKING_CALENDAR_ID = 'b7f0b872950ba2c899fb39414fdcc0333bbb5ca93e840a9c64e4bc5189389938@group.calendar.google.com';
export function createBookingCalendarProvider({ env = process.env, fetcher = fetch } = {}) {
  const calendarId = LEGACY_BOOKING_CALENDAR_ID;
  const names = { get: env.BOOKING_ZAPIER_GET_TOOL, write: env.BOOKING_ZAPIER_WRITE_TOOL };
  const configured = Boolean(env.BOOKING_CALENDAR_ID === calendarId && env.BOOKING_ZAPIER_MCP_URL && names.get && names.write);
  let session, sequence = 0, schemas, connecting;
  const apiRoot = 'https://www.googleapis.com/calendar/v3';
  const eventRoot = `${apiRoot}/calendars/${encodeURIComponent(calendarId)}/events`;
  async function rpc(method, params, notification = false, deadline = Infinity) {
    if (!configured) throw new Error('Calendar connection is not configured.');
    const url = new URL(env.BOOKING_ZAPIER_MCP_URL);
    if (url.protocol !== 'https:' || url.hostname !== 'mcp.zapier.com' || url.username || url.password) throw new Error('Invalid calendar connection.');
    const id = notification ? undefined : ++sequence;
    const timeout = Math.min(notification ? 5000 : 10000, deadline - Date.now());
    if (timeout <= 0) throw new Error('Calendar request deadline exceeded.');
    const response = await fetcher(url.href, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!response.ok) throw new Error('Calendar connection request failed.');
    session = response.headers.get('mcp-session-id') || session;
    // Initialized is a notification: 202/204 and an empty body are normal.
    if (notification) return;
    const raw = await response.text();
    if (raw.length > 1000000) throw new Error('Calendar response too large.');
    const frames = response.headers.get('content-type')?.includes('text/event-stream')
      ? raw.split(/\r?\n/).filter(line => line.startsWith('data:')).flatMap(line => { try { return [JSON.parse(line.slice(5).trim())]; } catch { return []; } })
      : [JSON.parse(raw)];
    const data = frames.find(frame => frame.id === id);
    if (!data || data.error || data.result?.isError) throw new Error('Calendar action failed.');
    return data.result;
  }
  async function connect(deadline) {
    if (schemas) return schemas;
    return connecting ||= (async () => {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'LegacyAI-booking', version: '1.0.0' } }, false, deadline);
      await rpc('notifications/initialized', undefined, true, deadline);
      const listing = await rpc('tools/list', {}, false, deadline);
      const result = {};
      for (const [mode, name] of Object.entries(names)) {
        const tool = listing?.tools?.find(item => item.name === name);
        if (!tool?.inputSchema?.properties?.url || (mode === 'write' && (!tool.inputSchema.properties.method || !tool.inputSchema.properties.body))) throw new Error('Configured calendar action is unavailable.');
        result[mode] = tool.inputSchema;
      }
      schemas = result;
      return schemas;
    })().catch(error => { connecting = null; throw error; });
  }
  // Zapier versions wrap API responses in body/data/result/results. Only a
  // genuine Calendar resource with its documented kind can leave this adapter.
  function resource(result, kind) {
    const candidates = [result?.structuredContent, result];
    for (const item of result?.content || []) if (item.type === 'text') {
      try { candidates.push(JSON.parse(item.text)); } catch { /* prose is not a receipt */ }
    }
    const seen = new Set();
    for (let i = 0; i < candidates.length && i < 60; i++) {
      let value = candidates[i];
      if (typeof value === 'string') { try { value = JSON.parse(value); } catch { continue; } }
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      if (value.error || (typeof value.status === 'number' && value.status >= 400) || (typeof value.status_code === 'number' && value.status_code >= 400)) continue;
      if (value.kind === kind) return value;
      for (const key of ['body', 'data', 'result', 'results', 'response', 'output', 'json']) {
        const child = value[key];
        if (Array.isArray(child)) candidates.push(...child); else if (child !== undefined) candidates.push(child);
      }
    }
    throw new Error('Calendar action did not return a verifiable resource.');
  }
  async function api(mode, url, body, kind, deadline) {
    if (!configured) throw new Error('The dedicated Legacy AI booking calendar is not configured.');
    const schema = (await connect(deadline))[mode];
    const args = { url, fail_on_errors: true, headers: { 'Content-Type': 'application/json' }, querystring: {} };
    if (schema.properties.method) args.method = mode === 'write' ? 'POST' : 'GET';
    if (mode === 'write') args.body = JSON.stringify(body);
    // Some installed Zapier actions expose these transport fields. They never
    // decide a calendar, recipient, URL, or operation.
    if (schema.properties.instructions) args.instructions = 'Execute the provided Google Calendar API request exactly. Return the complete API JSON body.';
    if (schema.properties.output_hint) args.output_hint = 'Return the complete unmodified API JSON response body, including kind, id, status, start, end, attendees and busy ranges when present.';
    for (const key of schema.required || []) if (args[key] === undefined) throw new Error('Calendar action schema needs configuration.');
    for (const key of Object.keys(args)) if (!schema.properties[key]) delete args[key];
    return resource(await rpc('tools/call', { name: names[mode], arguments: args }, false, deadline), kind);
  }
  return {
    configured, calendarId,
    async busy(timeMin, timeMax, { deadline } = {}) {
      const result = await api('write', `${apiRoot}/freeBusy`, { timeMin, timeMax, timeZone: 'America/Indianapolis', items: [{ id: calendarId }] }, 'calendar#freeBusy', deadline);
      const calendar = result.calendars?.[calendarId];
      if (!calendar || calendar.errors?.length || !Array.isArray(calendar.busy)) throw new Error('Calendar availability was not returned.');
      return calendar.busy.map(period => {
        if (!Number.isFinite(Date.parse(period.start)) || !Number.isFinite(Date.parse(period.end)) || Date.parse(period.start) >= Date.parse(period.end)) throw new Error('Invalid busy range.');
        return { start: period.start, end: period.end };
      });
    },
    async insert(event, { deadline } = {}) { return api('write', `${eventRoot}?sendUpdates=all`, event, 'calendar#event', deadline); },
    async get(id, { deadline } = {}) { return api('get', `${eventRoot}/${encodeURIComponent(id)}`, undefined, 'calendar#event', deadline); },
  };
}
