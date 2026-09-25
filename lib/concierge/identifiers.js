import { z } from 'zod';
export const noticeVersion = 'visitor-contact-2026-09-25-v1';
export const identifierSchema = z.object({ kind: z.enum(['name','company','email','phone','address']), value: z.string().trim().min(2).max(300) }).strict();
export const visitorInput = z.object({ visitorId: z.string().uuid(), page: z.string().regex(/^\/(?!\/)[^?#]*$/).max(200), fieldName: z.string().max(120), value: z.string().trim().min(2).max(8000), noticeVersion: z.literal(noticeVersion), signals: z.object({ collection: z.literal('notice-shown'), inquiryReply: z.boolean(), marketing: z.boolean() }).strict() }).strict();
export function directIdentifiers({ fieldName, value }) {
  const result = [];
  const add = (kind, value) => result.push({kind, value: value.trim()});
  // Names/addresses are taken only from explicitly labelled fields, never guessed.
  const kind = ({'lg-company':'company','lg-name':'name','cg-company':'company','cg-share-company':'company','cg-name':'name','cg-phone':'phone','cg-address':'address'})[fieldName];
  if (kind && value.trim().length >= 2 && value.length <= 300) add(kind, value);
  for (const match of value.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) add('email',match[0]);
  for (const match of value.matchAll(/(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\b\d{3})[ .-]\d{3}[ .-]\d{4}\b/g)) add('phone',match[0]);
  return uniqueIdentifiers(result);
}
export function uniqueIdentifiers(items) {
  const seen=new Set();
  return items.filter(item => { const key=`${item.kind}:${item.value.toLowerCase()}`; if(seen.has(key)) return false; seen.add(key); return true; });
}
export function groundedIdentifiers(items, text) {
  return uniqueIdentifiers(items.filter(item => identifierSchema.safeParse(item).success && text.toLowerCase().includes(item.value.toLowerCase())));
}
export function csvCell(value) { const s=String(value ?? ''); return '"'+ (/^[\s]*[=+@\-\t\r]/.test(s) ? "'"+s:s).replaceAll('"','""')+'"'; }
export function contactCSV(contacts) {
  const types=['name','company','email','phone','address'];
  return [['Visitor reference',...types,'IP context','First seen','Last seen','Source pages','Permission signals'],...contacts.map(c=>[c.visitorId,...types.map(k=>c.identifiers.filter(i=>i.kind===k).map(i=>i.value).join(' | ')), c.ipAddresses.join(' | '),c.firstSeen,c.lastSeen,c.pages.join(' | '),JSON.stringify(c.signals)])].map(row=>row.map(csvCell).join(',')).join('\r\n');
}
