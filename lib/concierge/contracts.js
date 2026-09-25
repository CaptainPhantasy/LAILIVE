import { z } from 'zod'
import catalog from './catalog-data.js'

export { catalog }
export const serviceById = new Map(catalog.services.map(service => [service.id, service]))
export const consent = Object.freeze({
  version: 'email-inquiry-2026-09-25-v1',
  inquiryText: 'I agree that Legacy AI Solutions may save the details and service interests in this inquiry and email me about this inquiry.',
  marketingText: 'I also agree to receive optional marketing emails from Legacy AI Solutions. I can withdraw this choice at any time.',
})
const serviceId = z.enum(catalog.services.map(service => service.id))
export const serviceIds = z.array(serviceId).max(12).refine(ids => new Set(ids).size === ids.length, 'Choose each service once.')
export const chatInput = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(4000) }).strict()).min(1).max(16),
  serviceIds: serviceIds.default([]),
}).strict().refine(input => input.messages.at(-1).role === 'user', 'End with your question.').refine(input => input.messages.reduce((n, m) => n + m.content.length, 0) <= 16000, 'Please shorten the conversation.')
export const inquiryInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  company: z.string().trim().max(160).default(''),
  message: z.string().trim().min(8).max(8000),
  serviceIds: serviceIds.default([]),
  approval: z.object({ confirmed: z.literal(true), consentVersion: z.literal(consent.version), marketingOptIn: z.boolean() }).strict(),
}).strict()
export const followUpInput = z.object({ inquiryId: z.string().uuid(), instructions: z.string().trim().max(1200).default('') }).strict()
export const chatOutput = z.object({ reply: z.string().min(1).max(7000), serviceIds: serviceIds.max(3), nextSteps: z.array(z.string().min(1).max(500)).max(5) })
export const draftOutput = z.object({ subject: z.string().min(1).max(200), body: z.string().min(1).max(6000) })
export const insightOutput = z.object({ summary: z.string().min(1).max(5000), nextSteps: z.array(z.string().min(1).max(500)).max(5) })
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
export function parse(schema, value) {
  const result = schema.safeParse(value)
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message || 'Invalid request.')
  return result.data
}
export function makeBrief(inquiry) {
  return {
    title: 'Your Legacy AI inquiry',
    text: [
      'LEGACY AI SOLUTIONS — INQUIRY BRIEF',
      `Receipt: ${inquiry.id}`,
      `Received: ${inquiry.createdAt}`,
      `Name: ${inquiry.name}`,
      `Email: ${inquiry.email}`,
      ...(inquiry.company ? [`Business: ${inquiry.company}`] : []),
      '', 'Your inquiry', inquiry.message, '', 'Services you selected',
      ...(inquiry.serviceIds.length ? inquiry.serviceIds.map(id => `- ${serviceById.get(id).name}`) : ['No specific services selected.']),
      '', 'Next step: Legacy AI Solutions can review this inquiry and reply by email. No appointment has been booked and no message has been sent to a customer.',
    ].join('\n'),
  }
}
