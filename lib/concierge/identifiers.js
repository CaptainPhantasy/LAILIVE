import { z } from 'zod';
export const noticeVersion = 'visitor-contact-2026-09-25-v1';
export const identifierSchema = z.object({ kind: z.enum(['name','company','email','phone','address']), value: z.string().trim().min(2).max(300) }).strict();
export const visitorInput = z.object({ visitorId: z.string().uuid(), page: z.string().regex(/^\/(?!\/)[^?#]*$/).max(200), fieldName: z.string().max(120), value: z.string().trim().min(2).max(8000), noticeVersion: z.literal(noticeVersion), signals: z.object({ collection: z.literal('notice-shown'), inquiryReply: z.boolean(), marketing: z.boolean() }).strict() }).strict();
const explicitFields = Object.freeze({
  'lg-company':'company','lg-name':'name','lg-email':'email',
  'cg-company':'company','cg-share-company':'company','cg-name':'name',
  'cg-email':'email','cg-phone':'phone','cg-address':'address'
});
export function explicitIdentifierKind(fieldName) {
  return Object.hasOwn(explicitFields,fieldName) ? explicitFields[fieldName] : null;
}
export function directIdentifiers({ fieldName, value }) {
  // An address mentioned in prose could belong to a competitor or an example.
  // Only an explicit self-contact field permits extraction without attribution.
  const kind=explicitIdentifierKind(fieldName);
  if(!kind || typeof value!=='string') return [];
  const identifier={kind,value:value.trim()};
  if(!identifierSchema.safeParse(identifier).success) return [];
  if(kind==='email' && !z.string().email().safeParse(identifier.value).success) return [];
  return [identifier];
}
export function uniqueIdentifiers(items) {
  const seen=new Set();
  return items.filter(item => { const key=`${item.kind}:${item.value.toLowerCase()}`; if(seen.has(key)) return false; seen.add(key); return true; });
}
export function groundedIdentifiers(items, text) {
  return uniqueIdentifiers(items.filter(item => identifierSchema.safeParse(item).success && text.toLowerCase().includes(item.value.toLowerCase())));
}
export function csvCell(value) { const s=String(value ?? ''); return '"'+ (/^[\s]*[=+@\-\t\r]/.test(s) ? "'"+s:s).replaceAll('"','""')+'"'; }
export function contactCSV(contacts, inquiries = [], services = []) {
  const types=['name','company','email','phone','address'];
  const serviceNames=new Map(services.map(service=>[service.id,service.name]));
  const headers=['Record source','Record reference','Visitor reference','Inquiry reference','Contact reference',
    'Name','Company','Email','Phone','Address','IP context','First seen','Last seen','Source pages','Source context',
    'Service interests','Inquiry text','Authoritative inquiry consent','Draft collection signals (not permission)'];
  const records=[
    ...contacts.map(c=>({time:c.lastSeen,reference:c.visitorId,row:[
      'Captured visitor details',c.visitorId,c.visitorId,'','',
      ...types.map(kind=>c.identifiers.filter(item=>item.kind===kind).map(item=>item.value).join(' | ')),
      c.ipAddresses.join(' | '),c.firstSeen,c.lastSeen,c.pages.join(' | '),'Entered details, including unfinished forms',
      '','','',JSON.stringify(c.signals)
    ]})),
    ...inquiries.map(inquiry=>({time:inquiry.createdAt,reference:inquiry.id,row:[
      'Submitted inquiry',inquiry.id,'',inquiry.id,inquiry.contactId,
      inquiry.name,inquiry.company,inquiry.email,'','','',inquiry.createdAt,inquiry.createdAt,'','Explicit inquiry submission',
      JSON.stringify(inquiry.serviceIds.map(id=>({id,...(serviceNames.has(id)?{name:serviceNames.get(id)}:{})}))),
      inquiry.message,JSON.stringify(inquiry.consent || []),''
    ]}))
  ];
  // These are distinct evidence records, never an identity merge by email or IP.
  records.sort((a,b)=>(Date.parse(b.time)-Date.parse(a.time)) || a.reference.localeCompare(b.reference));
  return [headers,...records.map(record=>record.row)].map(row=>row.map(csvCell).join(',')).join('\r\n');
}
