export const INTENT_KEY = 'legacy-service-intent-v1';
const validId = id => typeof id === 'string' && id.length <= 140 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);

export function cleanIntent(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.filter(item => item && validId(item.id) && !seen.has(item.id) && seen.add(item.id)).slice(-100).map(item => ({
    id: item.id, selected: item.selected === true, reads: Math.min(3, Math.max(0, Number.isInteger(item.reads) ? item.reads : 0)),
    recommended: item.recommended === true, dismissed: item.dismissed === true,
  }));
}

export function recordIntent(current, id, kind) {
  const items = cleanIntent(current);
  if (!validId(id) || !['select', 'deselect', 'read', 'recommend', 'dismiss'].includes(kind)) return items;
  const item = items.find(entry => entry.id === id) || { id, selected: false, reads: 0, recommended: false, dismissed: false };
  if (!items.includes(item)) items.push(item);
  if (kind === 'select') { item.selected = true; item.dismissed = false; }
  if (kind === 'deselect') item.selected = false;
  if (kind === 'read') { item.reads = Math.min(3, item.reads + 1); item.dismissed = false; }
  if (kind === 'recommend') item.recommended = true;
  if (kind === 'dismiss') { item.dismissed = true; item.selected = false; }
  return items.slice(-100);
}

export function rankIntent(current, services, selectedIds = [], limit = 6) {
  const allowed = new Map(services.map(service => [service.id, service]));
  let items = cleanIntent(current);
  for (const id of selectedIds) items = recordIntent(items, id, 'select');
  return items.filter(item => allowed.has(item.id) && !item.dismissed && (item.selected || item.reads || item.recommended)).map(item => ({
    ...allowed.get(item.id), selected: item.selected,
    reasons: [...(item.selected ? ['Selected by the visitor for comparison'] : []), ...(item.reads ? ['Visitor opened the service details'] : []), ...(item.recommended ? ['Suggested by the AI guide; this is not a visitor selection'] : [])],
    score: (item.selected ? 100 : 0) + (item.reads ? 20 + item.reads : 0) + (item.recommended ? 5 : 0),
  })).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, Math.max(0, Math.min(12, limit)));
}

export function readIntent(storage) {
  try { return cleanIntent(JSON.parse((storage || globalThis.sessionStorage).getItem(INTENT_KEY) || '[]')); } catch { return []; }
}
export function saveIntent(items, storage) {
  try { (storage || globalThis.sessionStorage).setItem(INTENT_KEY, JSON.stringify(cleanIntent(items))); } catch { /* Browsing still works without session storage. */ }
}
