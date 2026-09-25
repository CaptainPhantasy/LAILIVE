import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { visitorInput, directIdentifiers, contactCSV } from './identifiers.js'
import { z } from 'zod'
import { catalog, consent, chatInput, inquiryInput, followUpInput, makeBrief, parse, HttpError } from './contracts.js'

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(status === 429 ? { 'Retry-After': '3600' } : {}) } })
}
async function body(request, max = 32768) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send JSON content.')
  if (Number(request.headers.get('content-length') || 0) > max) throw new HttpError(413, 'Please shorten this request.')
  const reader = request.body?.getReader()
  if (!reader) throw new HttpError(400, 'Request body is required.')
  let bytes = 0, text = ''
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > max) { await reader.cancel(); throw new HttpError(413, 'Please shorten this request.') }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally { reader.releaseLock() }
  try { return JSON.parse(text) } catch { throw new HttpError(400, 'Invalid JSON request.') }
}
function protectOrigin(request) {
  const origin = request.headers.get('origin')
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'Use this service from the Legacy AI website.')
}
const positiveInt = (value, fallback, max) => { const n = Number(value || fallback); return Number.isInteger(n) && n > 0 && n <= max ? n : fallback }

export function createHandlers({ getStore, generation, requireOwner, env = process.env, now = () => new Date() }) {
  function wrap(method, handler) {
    return async request => {
      try {
        if (request.method !== method) throw new HttpError(405, 'Method not allowed.')
        protectOrigin(request)
        return await handler(request)
      } catch (error) {
        if (error instanceof HttpError) return json({ error: error.message }, error.status)
        // Deliberately exclude raw database/provider errors, tokens, and submitted text.
        return json({ error: 'The service could not complete this request. Please try again. No success has been confirmed.' }, 503)
      }
    }
  }
  async function limit(request, kind, ownerSubject) {
    const time = now(), hour = time.toISOString().slice(0, 13), day = time.toISOString().slice(0, 10)
    const identity = ownerSubject || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    const key = createHash('sha256').update(identity).digest('hex')
    const expiry = new Date(time.getTime() + 86400000).toISOString()
    const rules = [{ key: `${kind}:${hour}:${key}`, limit: kind === 'visitor' ? 120 : kind === 'submission' ? 10 : 12, expiresAt: expiry }]
    if (kind !== 'submission' && kind !== 'visitor') rules.push({ key: `generation:${day}`, limit: positiveInt(env.CONCIERGE_DAILY_REQUEST_LIMIT, 100, 10000), expiresAt: expiry })
    await getStore().consumeLimits(rules)
  }
  return {
    catalog: wrap('GET', async () => json({ ...catalog, consent, capabilities:{ chat:Boolean(env.DATABASE_URL && (env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN)), inquiries:Boolean(env.DATABASE_URL) } })),
    visitor: wrap('POST', async request => {
      const input=parse(visitorInput,await body(request,40000));
      await limit(request,'visitor');
      let identifiers=directIdentifiers(input);
      if (!identifiers.length && /\b(?:my|our|I am|I'm|we|name|company|business|address|phone)\b/i.test(input.value)) { await limit(request,'identity-generation'); identifiers=await generation.identify(input.value); };
      if (!identifiers.length) return json({saved:false,reason:'No contact identifier found.'},202);
      const candidate=request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
      return json(await getStore().saveContact(input,identifiers,isIP(candidate||'') ? candidate : null));
    }),
    ownerContacts: wrap('GET', async request => {
      await requireOwner(request);
      const url=new URL(request.url);
      if(url.searchParams.has('evidence')) return json({evidence:await getStore().contactEvidence(parse(z.string().uuid(),url.searchParams.get('evidence')))});
      const contacts=await getStore().listContacts(url.searchParams.get('format')==='csv'?10000:100);
      if(url.searchParams.get('format')==='csv') return new Response(contactCSV(contacts),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="legacy-visitor-contacts.csv"','Cache-Control':'no-store'}});
      return json({contacts});
    }),
    ownerAssistant: wrap('POST', async request => {
      const owner=await requireOwner(request);
      const {question}=parse(z.object({question:z.string().trim().min(3).max(1500)}).strict(),await body(request));
      await limit(request,'owner-generation',owner.subject);
      const [contacts,inquiries,counts]=await Promise.all([getStore().listContacts(50),getStore().listInquiries(30),getStore().getInsights(30,now())]);
      return json({answer:await generation.assistant(question,{contacts,inquiries,counts}), generatedAt:now().toISOString(),coverage:{contacts:contacts.length,inquiries:inquiries.length}});
    }),
    chat: wrap('POST', async request => {
      const input = parse(chatInput, await body(request, 70000))
      await limit(request, 'chat')
      return json(await generation.chat(input))
    }),
    inquiries: wrap('POST', async request => {
      const input = parse(inquiryInput, await body(request, 40000))
      const key = parse(z.string().uuid(), request.headers.get('idempotency-key'))
      await limit(request, 'submission')
      const saved = await getStore().saveInquiry(input, key)
      return json({ id: saved.id, createdAt: saved.createdAt, status: saved.status, replayed: saved.replayed, brief: makeBrief(saved) }, saved.replayed ? 200 : 201)
    }),
    ownerInquiries: wrap('GET', async request => {
      await requireOwner(request)
      const url = new URL(request.url)
      if (url.searchParams.has('id')) {
        const id = parse(z.string().uuid(), url.searchParams.get('id'))
        const inquiry = await getStore().getInquiry(id)
        if (!inquiry) throw new HttpError(404, 'Inquiry not found.')
        return json({ inquiry })
      }
      return json({ inquiries: await getStore().listInquiries(positiveInt(url.searchParams.get('limit'), 30, 100)) })
    }),
    ownerInsights: wrap('GET', async request => {
      const owner = await requireOwner(request)
      const days = positiveInt(new URL(request.url).searchParams.get('days'), 30, 365)
      const counts = await getStore().getInsights(days, now())
      await limit(request, 'owner-generation', owner.subject)
      const narrative = await generation.insights(counts)
      return json({ counts, narrative, generatedAt: now().toISOString() })
    }),
    ownerFollowUp: wrap('POST', async request => {
      const owner = await requireOwner(request)
      const input = parse(followUpInput, await body(request))
      const inquiry = await getStore().getInquiry(input.inquiryId)
      if (!inquiry) throw new HttpError(404, 'Inquiry not found.')
      await limit(request, 'owner-generation', owner.subject)
      const generated = await generation.followUp(inquiry, input.instructions)
      return json({ draft: await getStore().saveDraft(inquiry.id, owner.subject, generated.draft, generated.model), sent: false })
    }),
  }
}
