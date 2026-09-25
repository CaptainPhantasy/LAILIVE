import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'parse5';

const pages = {
  '/': 'dist/index.html',
  '/solutions/': 'dist/solutions/index.html',
  '/intake/': 'dist/intake/index.html',
  '/board/': 'dist/board/index.html',
  '/deal/': 'dist/deal/index.html',
  '/contact-health/': 'dist/contact-health/index.html',
};

const eachNode = (node, visit) => {
  visit(node);
  for (const child of node.childNodes || []) eachNode(child, visit);
};
const textOf = node => {
  let text = '';
  eachNode(node, n => { if (n.nodeName === '#text') text += n.value; });
  return text.replace(/\s+/g, ' ').trim();
};
const readPage = file => {
  const doc = parse(readFileSync(file, 'utf8'));
  const headings = [], labeled = [];
  eachNode(doc, node => {
    if (!node.tagName) return;
    if (/^h[1-6]$/.test(node.tagName)) headings.push({ level: +node.tagName[1], text: textOf(node) });
    if (['a', 'button', 'input', 'select', 'textarea'].includes(node.tagName) && node.attrs) {
      const label = node.attrs.find(a => a.name === 'aria-label')?.value;
      if (label) labeled.push({ tag: node.tagName, label, text: textOf(node) });
    }
  });
  return { headings, labeled };
};

test('heading levels never jump by more than one on any page', () => {
  for (const [route, file] of Object.entries(pages)) {
    const { headings } = readPage(file);
    assert(headings.length >= 1, `${route} needs headings`);
    assert.equal(headings[0].level, 1, `${route} should open with its h1`);
    assert.equal(headings.filter(h => h.level === 1).length, 1, `${route} should have exactly one h1`);
    for (let i = 1; i < headings.length; i++) {
      const step = headings[i].level - headings[i - 1].level;
      assert(step <= 1, `${route}: heading "${headings[i].text.slice(0, 40)}" jumps from h${headings[i - 1].level} to h${headings[i].level}`);
    }
  }
});

test('every visible word of a labeled control appears in its accessible name', () => {
  for (const [route, file] of Object.entries(pages)) {
    for (const { tag, label, text } of readPage(file).labeled) {
      const words = text.toLowerCase().split(' ').filter(w => /[a-z]{2}/.test(w));
      if (!words.length) continue;
      const name = label.toLowerCase();
      for (const word of words) assert(name.includes(word), `${route}: <${tag.toLowerCase()}> shows "${text.slice(0, 30)}" but its aria-label "${label}" omits "${word}"`);
    }
  }
});
