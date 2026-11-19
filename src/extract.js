import { createRequire } from 'node:module';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parse } from 'node-html-parser';
import { extractReadableText, splitHtml } from './chapters.js';

const PDF_HEADING = /^(?:(?:[0-9]{1,4}|[IVXLC]{1,8})\s+)?第\s*[0-9]{1,2}\s*章(?:\s+\S)|^(?:第[零〇一二三四五六七八九十百千0-9]+[章节回部篇]|chapter\s+\d+|#{1,3}\s+\S)/i;

const CHROME_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'form',
  'input',
  'textarea',
  'select',
  'option',
  'button',
  'menu',
  'dialog',
  'nav',
  'aside',
  'footer',
  '[hidden]',
  '[aria-hidden="true"]',
  '.sr-only',
  '.visually-hidden',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="toolbar"]',
  '[role="radiogroup"]',
  '[role="dialog"]',
  '[role="search"]',
].join(', ');

const SOURCE_LINE_RE = /^(?:来源|出处|原文(?:链接|地址)?|转载自|版权声明|责任编辑|发布时间|更新时间|作者|Source|Published)\s*[:：]/i;
const BOILERPLATE_ATTR_RE = /\b(?:breadcrumb|share|social|toolbar|byline|tag-list|tags|related-posts|comment-form|copyright)\b/i;

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

function inlineText(el) {
  return String(el?.text || '').replace(/\s+/g, ' ').trim();
}

function inlineLen(el) {
  return inlineText(el).length;
}

function compactLen(el) {
  return String(el?.text || '').replace(/\s+/g, '').length;
}

function pruneChrome(root) {
  for (const node of root.querySelectorAll(CHROME_SELECTORS)) {
    node.remove();
  }
  for (const header of root.querySelectorAll('header')) {
    if (header.querySelector('h1')) continue;
    const hasProseParagraph = header.querySelectorAll('p').some((p) => inlineLen(p) >= 40);
    if (!hasProseParagraph) header.remove();
  }
}

function longestCandidate(nodes, minChars = 30) {
  let best = null;
  let bestLen = 0;
  for (const node of nodes) {
    const len = inlineLen(node);
    if (len >= minChars && len > bestLen) {
      best = node;
      bestLen = len;
    }
  }
  return best;
}

function selectMainContainer(root) {
  const article = longestCandidate(root.querySelectorAll('article'));
  if (article) return article;

  const mainLike = longestCandidate(
    root.querySelectorAll('main, [role="main"], #js_content, .article-content, .post-content, .entry-content, .markdown-body, .prose'),
  );
  if (mainLike) return mainLike;

  return root.querySelector('body') || root;
}

function hasProtectedContent(el) {
  return Boolean(el.querySelector('h1, h2, h3, h4, h5, h6, blockquote'));
}

function pruneArticleNoise(container) {
  for (const el of container.querySelectorAll('div, ul, ol, section, p')) {
    if (!el.parentNode || hasProtectedContent(el) || el.querySelector('p')) continue;
    if (el.querySelector('time') && inlineLen(el) < 160) {
      el.remove();
    }
  }

  for (const el of container.querySelectorAll('div, ul, ol, p')) {
    if (!el.parentNode || hasProtectedContent(el)) continue;
    const links = el.querySelectorAll('a');
    if (links.length < 2) continue;
    const total = compactLen(el);
    if (total === 0) continue;
    const linkChars = links.reduce((sum, a) => sum + compactLen(a), 0);
    if (linkChars / total >= 0.75) {
      el.remove();
    }
  }

  for (const el of container.querySelectorAll('p, div')) {
    if (!el.parentNode || hasProtectedContent(el) || el.querySelector('p, section')) continue;
    const text = inlineText(el);
    if (text.length < 100 && SOURCE_LINE_RE.test(text)) {
      el.remove();
    }
  }

  for (const el of container.querySelectorAll('div, section, ul')) {
    if (!el.parentNode || hasProtectedContent(el) || inlineLen(el) >= 120) continue;
    const marker = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`;
    if (BOILERPLATE_ATTR_RE.test(marker)) {
      el.remove();
    }
  }
}

export function extractHtml(html) {
  const root = parse(String(html ?? ''));
  const documentTitle = root.querySelector('title')?.text?.trim() || '';
  pruneChrome(root);
  const container = selectMainContainer(root);
  pruneArticleNoise(container);
  const text = extractReadableText(container);
  const chapters = splitHtml(container, documentTitle);
  return { text, documentTitle, chapters };
}
