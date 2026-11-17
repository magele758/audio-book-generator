import { createRequire } from 'node:module';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parse } from 'node-html-parser';
import { splitHtml } from './chapters.js';

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
    return pieces.join('');
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
