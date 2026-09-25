export const LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, records: 10000, columns: 100 });

export function parseCSV(input, delimiter = ',') {
  if (typeof input !== 'string') throw new Error('Supply CSV text.');
  if (![',', ';', '\t'].includes(delimiter)) throw new Error('Choose a supported separator.');
  if (new TextEncoder().encode(input).length > LIMITS.bytes) throw new Error('This checker accepts files up to 2 MB. Split the file and check one part at a time.');
  const text = input.replace(/^\uFEFF/, '');
  const records = [];
  let fields = [], field = '', quoted = false, closed = false, used = false, line = 1, startLine = 1;
  const endField = () => {
    fields.push(field); field = ''; closed = false;
    if (fields.length > LIMITS.columns) throw new Error(`Line ${startLine} has more than ${LIMITS.columns} columns.`);
  };
  const endRecord = () => {
    endField();
    if (used || fields.length > 1 || fields[0] !== '') records.push({ values: fields, line: startLine });
    if (records.length > LIMITS.records + 1) throw new Error(`Check up to ${LIMITS.records.toLocaleString()} contact records at a time.`);
    fields = []; field = ''; used = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else {
        field += c;
        if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line++;
      }
    } else if (c === delimiter) { used = true; endField(); }
    else if (c === '\r' || c === '\n') {
      endRecord(); if (c === '\r' && text[i + 1] === '\n') i++;
      line++; startLine = line;
    } else if (c === '"' && !field && !closed) { quoted = true; used = true; }
    else {
      if (closed) throw new Error(`Unexpected text after a closing quote on line ${line}. Put the separator immediately after the quote.`);
      if (c === '"') throw new Error(`Unexpected quote on line ${line}. Quote the whole field and double any quote inside it.`);
      field += c; used = true;
    }
  }
  if (quoted) throw new Error(`An opened quote on the record starting at line ${startLine} was never closed.`);
  if (used || fields.length || field || closed) endRecord();
  if (records.length < 2) throw new Error('Include a header row and at least one contact record.');
  const headers = records.shift().values;
  if (headers.every(h => !h.trim())) throw new Error('Give the columns names in the first row.');
  const rows = records.map((record, i) => {
    if (record.values.length !== headers.length) throw new Error(`Line ${record.line} has ${record.values.length} fields; the header has ${headers.length}. Check the separator and any quoted commas before continuing.`);
    return { id: i + 2, line: record.line, values: record.values };
  });
  return { headers, rows };
}

const headerKey = value => value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases = {
  name: ['name', 'fullname', 'contactname', 'customername', 'clientname'],
  first: ['firstname', 'givenname', 'first'], last: ['lastname', 'surname', 'familyname', 'last'],
  email: ['email', 'emailaddress', 'contactemail', 'customeremail'],
  phone: ['phone', 'phonenumber', 'telephone', 'mobile', 'mobilenumber', 'cell', 'cellphone']
};
export function guessMapping(headers) {
  return Object.fromEntries(Object.entries(aliases).map(([role, names]) => [role, headers.findIndex(h => names.includes(headerKey(h)))]));
}
export function validateMapping(headers, mapping) {
  const roles = Object.keys(aliases), chosen = roles.map(r => mapping[r]).filter(n => n !== -1);
  if (roles.some(r => !Number.isInteger(mapping[r]) || mapping[r] < -1 || mapping[r] >= headers.length)) throw new Error('Choose a valid column for each field.');
  if (new Set(chosen).size !== chosen.length) throw new Error('Use each column only once in the field mapping.');
  if (mapping.name < 0 && mapping.first < 0 && mapping.last < 0) throw new Error('Choose a name, first-name or last-name column.');
  if (mapping.email < 0 && mapping.phone < 0) throw new Error('Choose at least one email or phone column.');
}
const normalized = value => value.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
export const phoneKey = value => {
  const text = value.trim(), extension = text.match(/\s*(?:ext\.?|x|#)\s*(\d+)\s*$/i);
  const base = extension ? text.slice(0, extension.index) : text;
  const digits = base.replace(/\D/g, '');
  return digits ? digits + (extension ? `x${extension[1]}` : '') : '';
};
export function contactFor(row, mapping) {
  const at = role => mapping[role] >= 0 ? row.values[mapping[role]].trim() : '';
  return { name: at('name') || [at('first'), at('last')].filter(Boolean).join(' '), email: at('email'), phone: at('phone') };
}

export function analyze(data, mapping) {
  validateMapping(data.headers, mapping);
  const issues = [], exact = new Map(), duplicates = new Set(), groups = { email: new Map(), phone: new Map() };
  const add = (row, code, message, fields = [], related = [], groupSize = 0) => issues.push({ record: row.id, line: row.line, code, message, fields, related, groupSize });
  for (const row of data.rows) {
    const contact = contactFor(row, mapping);
    if (!contact.name) add(row, 'missing_name', 'No name in the selected name columns.');
    if (!contact.email && !contact.phone) add(row, 'missing_contact', 'No email or phone in the selected contact columns.');
    if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) add(row, 'email_format', 'Email format needs review. This checker cannot confirm delivery.', [data.headers[mapping.email]]);
    const phone = phoneKey(contact.phone), digits = phone.split('x')[0];
    const extensionMatch = contact.phone.match(/\s*(?:ext\.?|x|#)\s*(\d+)\s*$/i);
    const base = extensionMatch ? contact.phone.slice(0, extensionMatch.index) : contact.phone;
    if (contact.phone && (digits.length < 7 || digits.length > 15 || /[a-z]/i.test(base.replace(/ext\.?/ig, '')))) add(row, 'phone_format', 'Phone format needs review. Include an area or country code where needed.', [data.headers[mapping.phone]]);
    const key = JSON.stringify(row.values);
    if (exact.has(key)) { duplicates.add(row.id); add(row, 'exact_duplicate', `Every original field exactly matches record ${exact.get(key)}.`, [], [exact.get(key)]); }
    else exact.set(key, row.id);
    for (const [kind, value] of [['email', normalized(contact.email)], ['phone', phone]]) {
      if (!value) continue;
      if (!groups[kind].has(value)) groups[kind].set(value, []);
      groups[kind].get(value).push(row);
    }
  }
  for (const [kind, groupMap] of Object.entries(groups)) for (const rows of groupMap.values()) {
    if (rows.length < 2 || new Set(rows.map(r => JSON.stringify(r.values))).size === 1) continue;
    const conflicts = data.headers.filter((header, index) => {
      const values = new Set(rows.map(row => index === mapping.phone ? phoneKey(row.values[index]) : normalized(row.values[index])).filter(Boolean));
      return values.size > 1;
    });
    const ids = rows.map(r => r.id);
    for (const [index, row] of rows.entries()) {
      const related = (index >= 20 ? ids.slice(0, 20) : ids.slice(0, index).concat(ids.slice(index + 1, 21)));
      add(row, conflicts.length ? 'possible_conflict' : 'shared_contact', conflicts.length ? `Shared ${kind}, different non-empty details. Review the records separately; this is not proof they are the same person.` : `Shared ${kind} with another non-identical record. This may be a shared household or business contact.`, conflicts, related, rows.length);
    }
  }
  const byRecord = new Map(data.rows.map(row => [row.id, []]));
  issues.forEach(issue => byRecord.get(issue.record).push(issue));
  return { issues, byRecord, duplicates, summary: { records: data.rows.length, withIssues: [...byRecord.values()].filter(list => list.length).length, exactDuplicates: duplicates.size, possibleConflicts: new Set(issues.filter(i => i.code === 'possible_conflict').map(i => i.record)).size } };
}

export const formulaLike = value => /^[\s\uFEFF]*[=+\-@]/.test(String(value)) || /^[\t\r\n]/.test(String(value));
export function encodeCSV(rows, { spreadsheetSafe = true } = {}) {
  return '\uFEFF' + rows.map(row => row.map(value => {
    let text = String(value ?? '');
    if (spreadsheetSafe && formulaLike(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n') + '\r\n';
}
export function draftRows(data, report, options = {}) {
  const excluded = options.excluded || new Set();
  return data.rows.filter(row => !excluded.has(row.id) && !(options.removeDuplicates && report.duplicates.has(row.id))).map(row => row.values.map(value => options.trim ? value.trim() : value));
}
export function issueRows(data, report) {
  const rows = new Map(data.rows.map(row => [row.id, row]));
  return [['Record', 'Starting CSV line', 'Check', 'Details', 'Fields to review', 'Related records (up to 20)', 'Shared-contact group size', ...data.headers.map(h => `Original: ${h}`)], ...report.issues.map(issue => [issue.record, issue.line, issue.code, issue.message, issue.fields.join('; '), issue.related.join('; '), issue.groupSize || '', ...rows.get(issue.record).values])];
}
