import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { visitorInput, directIdentifiers, explicitIdentifierKind, groundedIdentifiers, contactCSV } from './identifiers.js'
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
        // Keep diagnostics useful without logging submitted text, tokens or provider bodies.
        const safeCode = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,90}$/.test(value) ? value : undefined;
        console.error('legacy_service_failure', { route: new URL(request.url).pathname, name: safeCode(error?.name), code: safeCode(error?.code), status: Number.isInteger(error?.statusCode) ? error.statusCode : undefined, cause: safeCode(error?.cause?.name) });
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
      if (!explicitIdentifierKind(input.fieldName) && /\b(?:my|our|I am|I'm|we|name|company|business|address|phone)\b|@|(?:\d[ ().+-]*){7,}/i.test(input.value)) {
        await limit(request,'identity-generation');
        // The existing extractor distinguishes self-description from third parties.
        // Re-ground the complete result here instead of promoting raw regex hits.
        identifiers=groundedIdentifiers(await generation.identify(input.value),input.value);
      }
      if (!identifiers.length) return json({saved:false,reason:'No contact identifier found.'},202);
      const candidate=request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
      return json(await getStore().saveContact(input,identifiers,isIP(candidate||'') ? candidate : null));
    }),
    ownerContacts: wrap('GET', async request => {
      await requireOwner(request);
      const url=new URL(request.url);
      if(url.searchParams.has('evidence')) return json({evidence:await getStore().contactEvidence(parse(z.string().uuid(),url.searchParams.get('evidence')))});
      if(url.searchParams.get('format')==='csv') {
        const exportLimit=10000;
        const [contacts,inquiries]=await Promise.all([getStore().listContacts(exportLimit),getStore().listInquiries(exportLimit)]);
        return new Response(contactCSV(contacts,inquiries,catalog.services),{headers:{
          'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="legacy-visitor-contacts.csv"','Cache-Control':'no-store',
          'X-Export-Limit-Per-Source':String(exportLimit),
          'X-Export-Captured-Rows':String(contacts.length),'X-Export-Inquiry-Rows':String(inquiries.length),
          'X-Export-Scope':'Up to 10000 recently updated captured visitor records and 10000 most recent submitted inquiries; no identity merging.'
        }});
      }
      const contacts=await getStore().listContacts(100);
      return json({contacts});
    }),
    ownerAssistant: wrap('POST', async request => {
      const owner=await requireOwner(request);
      const {question}=parse(z.object({question:z.string().trim().min(3).max(1500)}).strict(),await body(request));
      await limit(request,'owner-generation',owner.subject);
      const [contacts,inquiries,counts]=await Promise.all([getStore().listContacts(50),getStore().listInquiries(30),getStore().getInsights(30,now())]);
      const context={
        contacts:contacts.map(({signals,...contact})=>({...contact,draftSignals:signals})),
        inquiries:inquiries.map(({consent,...inquiry})=>({...inquiry,consentReceipts:consent})),
        counts,
        permissionEvidence:{
          draftSignals:'Unsubmitted checkbox states are not permission to reply or send marketing, even when true.',
          consentReceipts:'Stored events from an explicitly submitted inquiry are authoritative only for that inquiry, purpose and channel. Quote the recorded choice, notice and action.',
          identity:'Do not transfer consent between visitor and inquiry records merely because names, email addresses or IP context appear to match. Missing receipts mean permission is unknown.'
        }
      };
      return json({answer:await generation.assistant(question,context), generatedAt:now().toISOString(),coverage:{contacts:contacts.length,inquiries:inquiries.length}});
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
