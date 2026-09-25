// Pure public-side operations. No private CRM access, storage, or model fallback.
export const MAX_SERVICES = 3;

export function readCatalog(value) {
  if (!value || !Array.isArray(value.services) || !value.services.length) throw new Error('The service catalog could not be loaded.');
  const ids = new Set();
  const services = value.services.map(service => {
    if (!service || typeof service.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(service.id) || ids.has(service.id) ||
        !['name', 'tag', 'body'].every(key => typeof service[key] === 'string' && service[key].trim())) {
      throw new Error('The service catalog is incomplete. Please try again.');
    }
    ids.add(service.id);
    return { id: service.id, name: service.name, tag: service.tag, body: service.body };
  });
  const consent = value.consent;
  const validConsent = consent && ['version', 'inquiryText', 'marketingText'].every(key => typeof consent[key] === 'string' && consent[key].trim());
  return { services, version: String(value.version || ''), consent: validConsent ? { ...consent } : null, capabilities: {chat: value.capabilities?.chat === true, inquiries: value.capabilities?.inquiries === true} };
}

export function selectedServices(ids, services) {
  const unique = [...new Set(ids.filter(id => typeof id === 'string' && id))];
  if (unique.length > MAX_SERVICES) throw new Error('Choose up to three services.');
  return unique.map(id => {
    const service = services.find(item => item.id === id);
    if (!service) throw new Error('A selected service is no longer in the catalog.');
    return service;
  });
}

const clean = value => typeof value === 'string' ? value.trim() : '';

export function composeBrief(fields, services) {
  const challenge = clean(fields.challenge);
  if (!challenge) throw new Error('Describe the task you would like to make easier.');
  const lines = [
    'LEGACY AI — MY WORKFLOW BRIEF',
    'Prepared from the details I supplied. A discussion brief, not agreed scope or a quote.',
    '', 'Business', clean(fields.company) || 'Not supplied',
    '', 'What I want to make easier', challenge,
    '', 'The result I want', clean(fields.goal) || 'Not supplied',
    '', 'Tools or process I use now', clean(fields.tools) || 'Not supplied',
    '', 'Timing', clean(fields.timing) || 'Not supplied',
    '', 'Services I want to discuss',
    ...(services.length ? services.flatMap(service => [`- ${service.name}`, `  /solutions/#${service.id}`]) : ['None selected yet']),
    '', 'Questions for the conversation', clean(fields.questions) || 'None added yet'
  ];
  if (clean(fields.suggestions)) lines.push('', 'Suggested next steps for review (not agreed work)', clean(fields.suggestions));
  return lines.join('\n');
}

export function readChatResponse(value, services) {
  if (!value || typeof value.reply !== 'string' || !value.reply.trim()) throw new Error('The guide did not return an answer. Your question is still here.');
  const serviceIds = Array.isArray(value.serviceIds) ? [...new Set(value.serviceIds)].filter(id => services.some(service => service.id === id)).slice(0, MAX_SERVICES) : [];
  const nextSteps = Array.isArray(value.nextSteps) ? value.nextSteps.filter(step => typeof step === 'string' && step.trim()).slice(0, 6) : [];
  return { reply: value.reply.trim(), serviceIds, nextSteps };
}

export function buildInquiry(fields, serviceIds, services, consent) {
  if (!consent?.version) throw new Error('The current sharing notice is unavailable. You can still download your brief.');
  if (!fields.confirmed) throw new Error('Confirm that Douglas may save these details and reply about this inquiry by email.');
  const name = clean(fields.name), email = clean(fields.email), message = clean(fields.message);
  if (!name) throw new Error('Add the name Douglas should use in his reply.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Add a valid reply email address.');
  if (message.length < 10) throw new Error('Add the brief you want Douglas to receive.');
  if (message.length > 8000) throw new Error('Please shorten the brief to 8,000 characters before sharing.');
  return {
    name, email, company: clean(fields.company), message,
    serviceIds: selectedServices(serviceIds, services).map(service => service.id),
    approval: { confirmed: true, consentVersion: consent.version, marketingOptIn: fields.marketingOptIn === true }
  };
}

export function readReceipt(value) {
  if (!value || value.status !== 'received' || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('A saved receipt was not confirmed. Keep your brief and retry; the same inquiry reference will be used.');
  }
  return { id: value.id, createdAt: value.createdAt, status: value.status, replayed: value.replayed === true,
    brief: value.brief && typeof value.brief.text === 'string' ? value.brief.text : null };
}
