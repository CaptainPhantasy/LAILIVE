import { sql } from 'drizzle-orm';

// Surfaces captured-but-unconsumed records in the owner digest: pending
// dictated drafts, content drafts awaiting or receiving a decision, approved
// review replies, reported prospects, and open invoices. Each source is queried
// independently and degrades to a skipped note — a table that never
// materialized (a module whose migration has not run) must never fail the
// digest. composeDigest renders the returned strings verbatim.
const plural = (n, word, pluralWord = `${word}s`) => `${n} ${n === 1 ? word : pluralWord}`;
const note = async (db, build, query) => {
  try {
    const text = build((await db.execute(query)).rows);
    return text ? [text] : [];
  } catch { return []; }
};

export async function gatherDigestNotes(db, { since } = {}) {
  const sinceIso = since instanceof Date ? since.toISOString() : String(since ?? '');
  return [
    ...await note(db, rows => rows.length ? `${plural(rows.length, 'dictated draft')} awaiting your review: ${rows.map(row => row.title).join(', ')}` : null,
      sql`SELECT kind,title,created_at FROM legacy_owner_documents WHERE status='draft' ORDER BY created_at DESC LIMIT 10`),
    ...await note(db, rows => {
      const awaiting = rows.filter(row => row.status === 'draft').length, decided = rows.length - awaiting;
      return awaiting + decided ? `${plural(awaiting, 'content draft')} awaiting review; ${decided} approved since the last update` : null;
    },
      sql`SELECT topic,channel,status,created_at,decided_at FROM legacy_content_drafts WHERE (status='draft') OR (status='approved' AND decided_at >= ${sinceIso}::timestamptz) ORDER BY created_at DESC LIMIT 10`),
    ...await note(db, rows => rows.length ? `${plural(rows.length, 'approved review reply', 'approved review replies')} ready to paste: ${rows.map(row => row.reviewer || 'a customer').join(', ')}` : null,
      sql`SELECT reviewer,rating,approved_at FROM legacy_review_responses WHERE status='approved' AND approved_at >= ${sinceIso}::timestamptz ORDER BY approved_at DESC LIMIT 10`),
    ...await note(db, rows => rows.length ? `${plural(rows.length, 'prospect')} reported and ready to review: ${rows.map(row => row.name).join(', ')}` : null,
      sql`SELECT name,reported_at FROM legacy_prospects WHERE status='reported' AND reported_at >= ${sinceIso}::timestamptz ORDER BY reported_at DESC LIMIT 10`),
    ...await note(db, rows => rows[0]?.n ? `${plural(rows[0].n, 'open invoice')} soonest due ${rows[0].next_due} (chase emails 3 days ahead)` : null,
      sql`SELECT count(*)::int AS n, min(due_date) AS next_due FROM legacy_invoices i JOIN legacy_owner_documents d ON d.id=i.document WHERE i.status='open'`),
  ];
}
