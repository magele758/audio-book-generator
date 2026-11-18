import { createRequire } from 'node:module';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parse } from 'node-html-parser';
import { splitHtml } from './chapters.js';

const PDF_HEADING = /^(?:(?:[0-9]{1,4}|[IVXLC]{1,8})\s+)?第\s*[0-9]{1,2}\s*章(?:\s+\S)|^(?:第[零〇一二三四五六七八九十百千0-9]+[章节回部篇]|chapter\s+\d+|#{1,3}\s+\S)/i;

function isPdfHeading(line) {
  return PDF_HEADING.test(line.trim().replace(/\s+/g, ' '));
}

function joinWrap(left, right) {
  if (!left) return right;
  if (/[A-Za-z]$/.test(left) && /^[A-Za-z]/.test(right)) return `${left} ${right}`;
  return `${left}${right}`;
}

export function unwrapPdfLines(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let buffer = '';
  const flush = () => {
    if (buffer) out.push(buffer);
    buffer = '';
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      out.push('');
      continue;
    }
    if (isPdfHeading(trimmed)) {
      flush();
      out.push(trimmed.replace(/\s+/g, ' '));
      continue;
    }
    buffer = joinWrap(buffer, trimmed);
    if (/[。！？!?；;]$/.test(trimmed)) flush();
  }
  flush();
  return out.join('\n');
}

const require = createRequire(import.meta.url);
const standardFontDataUrl = `${path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}${path.sep}`;

export async function extractPdfText(pdfBytes) {
  const data = new Uint8Array(pdfBytes);
  const task = getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    standardFontDataUrl,
  });
  const doc = await task.promise;
  try {
    const pieces = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        pieces.push(item.str);
        pieces.push(item.hasEOL ? '\n' : ' ');
      }
    }
    return unwrapPdfLines(pieces.join(''));
  } finally {
    if (typeof doc.destroy === 'function') await doc.destroy();
    if (typeof task.destroy === 'function') await task.destroy();
  }
}

export function extractHtml(html) {
  const root = parse(String(html ?? ''));
  for (const node of root.querySelectorAll('script, style, noscript')) node.remove();
  const documentTitle = root.querySelector('title')?.text?.trim() || '';
  const body = root.querySelector('body');
  const text = String((body || root).text || '').trim();
  const chapters = splitHtml(root, documentTitle);
  return { text, documentTitle, chapters };
}
