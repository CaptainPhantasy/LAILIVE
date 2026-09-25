import { randomUUID, createHash } from 'node:crypto'
import { uniqueIdentifiers } from './identifiers.js'
import { sql } from 'drizzle-orm'
import { catalog, consent, serviceById, HttpError } from './contracts.js'

const rows = result => result.rows
const hash = input => createHash('sha256').update(JSON.stringify(input)).digest('hex')
const timestamp = value => new Date(value).toISOString()
const mapContact = row => ({ visitorId: row.visitor_id, identifiers: row.identifiers, ipAddresses: row.ip_addresses, pages: row.pages, signals: row.signals, firstSeen: timestamp(row.first_seen), lastSeen: timestamp(row.last_seen) })
const mapInquiry = row => ({ id: row.id, contactId: row.contact_id, name: row.name, email: row.email, company: row.company, message: row.message, status: row.status, createdAt: timestamp(row.created_at), serviceIds: row.service_ids || [] })

export function createStore(db) {
  async function getInquiry(id, connection = db) {
    const found = rows(await connection.execute(sql`
      SELECT i.*, c.name, c.email, c.company,
        COALESCE((SELECT json_agg(service_id ORDER BY service_id) FROM legacy_inquiry_interests WHERE inquiry_id = i.id), '[]'::json) AS service_ids
      FROM legacy_inquiries i JOIN legacy_contacts c ON c.id = i.contact_id WHERE i.id = ${id}::uuid
    `))[0]
    if (!found) return null;
    const inquiry=mapInquiry(found);
    inquiry.consent=rows(await connection.execute(sql`SELECT purpose,channel,choice,notice_version,notice_text,created_at FROM legacy_consent_events WHERE inquiry_id=${id}::uuid ORDER BY created_at`));
    inquiry.drafts=rows(await connection.execute(sql`SELECT id,subject,body,state,created_at FROM legacy_follow_up_drafts WHERE inquiry_id=${id}::uuid ORDER BY created_at DESC`));
    return inquiry
  }
  return {
    getInquiry,
    async saveContact(input, identifiers, ipAddress) {
      return db.transaction(async tx => {
        await tx.execute(sql`INSERT INTO legacy_visitor_contacts(visitor_id,identifiers,signals) VALUES (${input.visitorId}::uuid,'[]'::jsonb,${JSON.stringify(input.signals)}::jsonb) ON CONFLICT DO NOTHING`);
        const existing=rows(await tx.execute(sql`SELECT * FROM legacy_visitor_contacts WHERE visitor_id=${input.visitorId}::uuid FOR UPDATE`))[0];
        const merged=uniqueIdentifiers([...existing.identifiers,...identifiers]);
        const ips=[...new Set([...existing.ip_addresses,...(ipAddress?[ipAddress]:[])])].slice(-20);
        const pages=[...new Set([...existing.pages,input.page])].slice(-40);
        await tx.execute(sql`UPDATE legacy_visitor_contacts SET identifiers=${JSON.stringify(merged)}::jsonb,ip_addresses=${JSON.stringify(ips)}::jsonb,pages=${JSON.stringify(pages)}::jsonb,signals=${JSON.stringify(input.signals)}::jsonb,last_seen=now() WHERE visitor_id=${input.visitorId}::uuid`);
        await tx.execute(sql`INSERT INTO legacy_contact_evidence(id,visitor_id,identifiers,page,field_name,signals,notice_version) VALUES (${randomUUID()}::uuid,${input.visitorId}::uuid,${JSON.stringify(identifiers)}::jsonb,${input.page},${input.fieldName},${JSON.stringify(input.signals)}::jsonb,${input.noticeVersion})`);
        return { saved: true };
      });
    },
    async listContacts(limit=100) { return rows(await db.execute(sql`SELECT * FROM legacy_visitor_contacts ORDER BY last_seen DESC LIMIT ${limit}`)).map(mapContact); },
    async contactEvidence(visitorId) { return rows(await db.execute(sql`SELECT identifiers,page,field_name,signals,notice_version,created_at FROM legacy_contact_evidence WHERE visitor_id=${visitorId}::uuid ORDER BY created_at DESC LIMIT 100`)); },
    async saveInquiry(input, idempotencyKey) {
      const bodyHash = hash(input), inquiryId = randomUUID(), contactId = randomUUID()
      return db.transaction(async tx => {
        const claimed = rows(await tx.execute(sql`
          INSERT INTO legacy_submission_receipts(idempotency_key,body_hash,inquiry_id)
          VALUES (${idempotencyKey}::uuid,${bodyHash},${inquiryId}::uuid)
          ON CONFLICT (idempotency_key) DO NOTHING RETURNING inquiry_id
        `))
        if (!claimed.length) {
          const previous = rows(await tx.execute(sql`SELECT body_hash,inquiry_id FROM legacy_submission_receipts WHERE idempotency_key=${idempotencyKey}::uuid`))[0]
          if (!previous || previous.body_hash !== bodyHash) throw new HttpError(409, 'This submission key was already used with different details. Start a new submission.')
          return { ...(await getInquiry(previous.inquiry_id, tx)), replayed: true }
        }
        await tx.execute(sql`INSERT INTO legacy_contacts(id,name,email,company) VALUES (${contactId}::uuid,${input.name},${input.email},${input.company})`)
        await tx.execute(sql`INSERT INTO legacy_inquiries(id,contact_id,message,catalog_version) VALUES (${inquiryId}::uuid,${contactId}::uuid,${input.message},${catalog.version})`)
        for (const id of input.serviceIds) await tx.execute(sql`INSERT INTO legacy_inquiry_interests(inquiry_id,service_id,service_name) VALUES (${inquiryId}::uuid,${id},${serviceById.get(id).name})`)
        for (const event of [
          { purpose: 'inquiry-reply', choice: 'granted', text: consent.inquiryText },
          { purpose: 'marketing', choice: input.approval.marketingOptIn ? 'granted' : 'declined', text: consent.marketingText },
        ]) await tx.execute(sql`
          INSERT INTO legacy_consent_events(id,inquiry_id,contact_id,purpose,channel,choice,notice_version,notice_text,action)
          VALUES (${randomUUID()}::uuid,${inquiryId}::uuid,${contactId}::uuid,${event.purpose},'email',${event.choice},${consent.version},${event.text},'visitor-confirmed-inquiry-submit')
        `)
        return { ...(await getInquiry(inquiryId, tx)), replayed: false }
      })
    },
    async listInquiries(limit) {
      const found = rows(await db.execute(sql`
        SELECT i.*, c.name, c.email, c.company,
          COALESCE((SELECT json_agg(service_id ORDER BY service_id) FROM legacy_inquiry_interests WHERE inquiry_id=i.id), '[]'::json) AS service_ids
        FROM legacy_inquiries i JOIN legacy_contacts c ON c.id=i.contact_id ORDER BY i.created_at DESC,i.id LIMIT ${limit}
      `))
      return found.map(mapInquiry)
    },
    async getInsights(days, now = new Date()) {
      const since = new Date(now.getTime() - days * 86400000).toISOString()
      const totals = rows(await db.execute(sql`SELECT count(*)::integer AS inquiries FROM legacy_inquiries WHERE created_at >= ${since}::timestamptz AND created_at <= ${now.toISOString()}::timestamptz`))[0]
      const interests = rows(await db.execute(sql`
        SELECT x.service_id AS "serviceId", x.service_name AS name, count(*)::integer AS inquiries
        FROM legacy_inquiry_interests x JOIN legacy_inquiries i ON i.id=x.inquiry_id
        WHERE i.created_at >= ${since}::timestamptz AND i.created_at <= ${now.toISOString()}::timestamptz
        GROUP BY x.service_id,x.service_name ORDER BY inquiries DESC,x.service_id LIMIT 12
      `))
      return { from: since, to: now.toISOString(), days, inquiries: totals.inquiries, interests }
    },
    async saveDraft(inquiryId, ownerSubject, draft, model) {
      const row = rows(await db.execute(sql`
        INSERT INTO legacy_follow_up_drafts(id,inquiry_id,owner_subject,subject,body,model)
        VALUES (${randomUUID()}::uuid,${inquiryId}::uuid,${ownerSubject},${draft.subject},${draft.body},${model}) RETURNING id,created_at
      `))[0]
      return { id: row.id, ...draft, createdAt: timestamp(row.created_at), state: 'draft' }
    },
    async consumeLimits(rules) {
      await db.transaction(async tx => {
        for (const rule of rules) {
          const result = rows(await tx.execute(sql`
            INSERT INTO legacy_rate_limits(bucket,count,expires_at) VALUES (${rule.key},1,${rule.expiresAt}::timestamptz)
            ON CONFLICT(bucket) DO UPDATE SET count=legacy_rate_limits.count+1
            WHERE legacy_rate_limits.count < ${rule.limit} RETURNING count
          `))
          if (!result.length) throw new HttpError(429, 'The service has reached its request allowance. Please try again later.')
        }
        await tx.execute(sql`DELETE FROM legacy_rate_limits WHERE expires_at < now() - interval '1 day'`)
      })
    },
  }
}
