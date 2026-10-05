// The hosted native voice demo replaces the custom AI Chat turn endpoint.
export default { fetch: () => Response.json({ error: 'This preview demo uses browser voice. Start the call on the receptionist page.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) };
