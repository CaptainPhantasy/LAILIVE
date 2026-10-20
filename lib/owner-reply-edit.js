const help = 'Use a specific correction such as Change "old text" to "new text", Change the total to $125, or REPLACE: followed by the complete corrected document.';
const fail = message => ({ ok: false, error: `${message} The original draft was kept. ${help}` });
// Unquoted replacement text is not protected by quotation marks, so terminal
// sentence punctuation belongs to the instruction, not the document. Quoted
// replacement text is never altered.
const stripTerminalPunctuation = value => value.replace(/[.。!！?？]+$/, '');

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Deliberately bounded editing: use only wording supplied by the owner. Missing
// or ambiguous targets need clarification instead of a guessed rewrite/model call.
export function applyOwnerReplyEdit(original, instruction) {
  if (typeof original !== 'string' || typeof instruction !== 'string') return fail('The correction is invalid.');
  let content;
  const reply = instruction.trim();
  if (/^REPLACE:/i.test(reply)) {
    content = reply.slice(8).trim();
  } else {
    const quoted = /^(?:please\s+)?(?:change|replace|correct)\s+(?:"([^"]+)"|'([^']+)'|“([^”]+)”)\s+(?:to|with)\s+(?:"([^"]*)"|'([^']*)'|“([^”]*)”)[.!]?$/i.exec(reply);
    if (quoted) {
      const oldText = quoted[1] ?? quoted[2] ?? quoted[3];
      const newText = quoted[4] ?? quoted[5] ?? quoted[6];
      const at = original.indexOf(oldText);
      if (at < 0) return fail('The text to change was not found.');
      if (original.indexOf(oldText, at + 1) >= 0) return fail('The text to change appears more than once.');
      content = original.slice(0, at) + newText + original.slice(at + oldText.length);
    } else {
      const field = /^(?:please\s+)?(?:change|set|update|correct)\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,60})\s+to\s+([^\r\n]+?)[.!]?$/i.exec(reply);
      if (field) {
        const label = field[1].trim();
        const lines = [...original.matchAll(new RegExp(`^([ \\t]*${escape(label)}[ \\t]*:[ \\t]*)([^\\r\\n]*)(?=\\r?$)`, 'gmi'))];
        if (lines.length > 1) return fail('That field appears more than once.');
        if (lines.length === 1) {
          const line = lines[0];
          content = original.slice(0, line.index) + line[1] + field[2] + original.slice(line.index + line[0].length);
        } else {
          if ((reply.match(/\s+(?:to|with)\s+/gi) || []).length !== 1) return fail('That correction has more than one possible text boundary; put the old and new text in quotes.');
          const exact = /^(?:please\s+)?(?:change|replace)\s+(.+?)\s+(?:to|with)\s+(.+)$/i.exec(reply);
          const at = exact ? original.indexOf(exact[1]) : -1;
          if (at < 0 || original.indexOf(exact[1], at + 1) >= 0) return fail('The field or exact text to change was not found exactly once.');
          content = original.slice(0, at) + stripTerminalPunctuation(exact[2]) + original.slice(at + exact[1].length);
        }
      } else {
        if ((reply.match(/\s+(?:to|with)\s+/gi) || []).length !== 1) return fail('That correction has more than one possible text boundary; put the old and new text in quotes.');
        const plain = /^(?:please\s+)?(?:change|replace)\s+(.+?)\s+(?:to|with)\s+(.+)$/i.exec(reply);
        if (!plain || /[\r\n]/.test(reply)) return fail('That correction is not specific enough.');
        const at = original.indexOf(plain[1]);
        if (at < 0 || original.indexOf(plain[1], at + 1) >= 0) return fail('The text to change was not found exactly once.');
        content = original.slice(0, at) + stripTerminalPunctuation(plain[2]) + original.slice(at + plain[1].length);
      }
    }
  }
  if (!content?.trim()) return fail('The correction would empty the document.');
  if (content.length > 10000) return fail('The corrected document is longer than 10,000 characters.');
  return { ok: true, content, changed: content !== original };
}
