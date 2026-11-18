const PLAIN_RULES = [
  /^第[零〇一二三四五六七八九十百千0-9]+[章节回部篇]/,
  /^chapter\s+\d+/i,
  /^#{1,3}\s+/,
];

// pdfjs often prints "IX 第 1 章 标题" or "22 第 2 章 标题", with spaces inside 第 N 章.
const NUMBERED_CHAPTER = /^(?:(?<mark>[0-9]{1,4}|[IVXLC]{1,8})\s+)?第\s*(?<num>[0-9]{1,2})\s*章(?:\s+(?<title>\S.*?))?$/;
const SENTENCE_MARK = /[。，；：？！,;!?]/;

function collapseLine(line) {
  return String(line || '').trim().replace(/\s+/g, ' ');
}

function numberedChapterHits(lines) {
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    const collapsed = collapseLine(lines[index]);
    const match = NUMBERED_CHAPTER.exec(collapsed);
    if (!match?.groups?.title || match.groups.title.length < 2) continue;
    if (SENTENCE_MARK.test(collapsed)) continue;
    found.push({
      index,
      marked: Boolean(match.groups.mark),
      title: `第${match.groups.num}章 ${match.groups.title}`.replace(/\s+/g, ' ').trim(),
    });
  }
  const marked = found.filter((hit) => hit.marked);
  const chosen = marked.length >= 2 ? marked : found;
  return chosen.length >= 2 ? chosen : [];
}

function chaptersFromHits(lines, hits, preambleTitle) {
  const chapters = [];
  const preamble = lines.slice(0, hits[0].index).join('\n').trim();
  if (preamble.length >= 80) chapters.push({ title: preambleTitle, text: preamble });
  for (let position = 0; position < hits.length; position += 1) {
    const start = hits[position].index;
    const end = position + 1 < hits.length ? hits[position + 1].index : lines.length;
    chapters.push({
      title: hits[position].title,
      text: lines.slice(start + 1, end).join('\n').trim(),
    });
  }
  return chapters;
}

export function splitPlainText(text, documentTitle) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const numbered = numberedChapterHits(lines);
  if (numbered.length >= 2) return chaptersFromHits(lines, numbered, '前言');
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
