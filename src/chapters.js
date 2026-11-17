const PLAIN_RULES = [
  /^第[零〇一二三四五六七八九十百千0-9]+[章节回部篇]/,
  /^chapter\s+\d+/i,
  /^#{1,3}\s+/,
];

export function splitPlainText(text, documentTitle) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  for (const rule of PLAIN_RULES) {
    const hits = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (rule.test(lines[index].trim())) hits.push(index);
    }
    if (hits.length >= 2) {
      return hits.map((start, position) => {
        const end = position + 1 < hits.length ? hits[position + 1] : lines.length;
        const rawTitle = lines[start].trim();
        const title = rawTitle.replace(/^#{1,3}\s+/, '').trim();
        const body = lines.slice(start + 1, end).join('\n').trim();
        return { title, text: body };
      });
    }
  }
  const title = String(documentTitle ?? '').trim() || 'Chapter 1';
  return [{ title, text: normalized.trim() }];
}

export function splitHtml(root, documentTitle) {
  const h1 = [...root.querySelectorAll('h1')];
  const chosen = h1.length >= 2 ? h1 : [...root.querySelectorAll('h2')];
  if (chosen.length < 2) {
    const title = String(documentTitle ?? '').trim() || 'Chapter 1';
    return [{ title, text: elementText(root) }];
  }
  return sliceByHeadings(root, chosen);
}

function elementText(root) {
  const body = root.querySelector?.('body');
  const source = body || root;
  return String(source.text || '').trim();
}

function countNodes(node) {
  let count = 1;
  for (const child of node.childNodes || []) count += countNodes(child);
  return count;
}

function flatten(node, acc = []) {
  acc.push(node);
  for (const child of node.childNodes || []) flatten(child, acc);
  return acc;
}

function sliceByHeadings(root, headings) {
  const flat = flatten(root);
  const marks = headings.map((heading) => {
    const start = flat.indexOf(heading);
    return { heading, start, after: start + countNodes(heading) };
  });
  return marks.map((mark, index) => {
    const end = index + 1 < marks.length ? marks[index + 1].start : flat.length;
    const chunks = [];
    for (let cursor = mark.after; cursor < end; cursor += 1) {
      const node = flat[cursor];
      if (node.nodeType !== 3) continue;
      const value = String(node.rawText ?? node.text ?? '').trim();
      if (value) chunks.push(value);
    }
    return { title: mark.heading.text.trim(), text: chunks.join('\n').trim() };
  });
}
