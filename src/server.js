import { createReadStream } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { splitPlainText } from './chapters.js';
import { extractHtml, extractPdfText } from './extract.js';
import { testIndexTts } from './indextts.js';
import {
  addBook,
  generateBook,
  generateChapter,
  getBook,
  hasVoiceRef,
  httpError,
  previewVoice,
  readRegistry,
  readTtsSettings,
  saveTtsSettings,
  saveVoiceRef,
} from './library.js';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const publicDir = path.join(rootDir, 'public');
const playerFile = path.join(rootDir, 'src', 'player.js');
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 20 * 1024 * 1024;

const STATIC = {
  '/': { file: path.join(publicDir, 'index.html'), type: 'text/html; charset=utf-8' },
  '/index.html': { file: path.join(publicDir, 'index.html'), type: 'text/html; charset=utf-8' },
  '/styles.css': { file: path.join(publicDir, 'styles.css'), type: 'text/css; charset=utf-8' },
  '/app.js': { file: path.join(publicDir, 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/player.js': { file: playerFile, type: 'text/javascript; charset=utf-8' },
};

function previewOf(chapter) {
  const body = String(chapter.text || '').replace(/\s+/g, ' ').trim();
  const source = body || String(chapter.title || '').trim();
  if (source.length <= 180) return source;
  return `${source.slice(0, 180).trimEnd()}…`;
}

function clip(text, limit) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  if (body.length <= limit) return body;
  return `${body.slice(0, limit - 1).trimEnd()}…`;
}

function presentSegment(segment) {
  return {
    id: segment.id,
    index: segment.index,
    text: clip(segment.text, 80),
    audio: {
      status: segment.audio.status,
      bytes: segment.audio.bytes,
      error: segment.audio.error,
    },
  };
}

export function presentBook(book) {
  return {
    ...book,
    chapters: book.chapters.map((chapter) => ({
      id: chapter.id,
      index: chapter.index,
      title: chapter.title,
      text: chapter.text,
      preview: previewOf(chapter),
      segments: (chapter.segments || []).map(presentSegment),
    })),
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(httpError(413, 'payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw httpError(400, 'invalid json');
    }
    return parsed;
  } catch (error) {
    if (error.status) throw error;
    throw httpError(400, 'invalid json');
  }
}

function basenameOrThrow(filename, message) {
  const base = path.basename(String(filename || '').trim());
  if (!base || base === '.' || base === '..') throw httpError(400, message);
  return base;
}

function titleFromFilename(filename) {
  return filename.replace(/\.[^.]+$/, '') || filename;
}

async function importPdf(libraryDir, payload) {
  const filename = basenameOrThrow(payload.filename, 'pdf import requires filename and pdfBase64');
  if (typeof payload.pdfBase64 !== 'string' || payload.pdfBase64.trim() === '') {
    throw httpError(400, 'pdf import requires filename and pdfBase64');
  }
  const bytes = Buffer.from(payload.pdfBase64, 'base64');
  if (bytes.length === 0) throw httpError(400, 'empty extract');
  let text;
  try {
    text = await extractPdfText(bytes);
  } catch {
    throw httpError(400, 'could not read pdf');
  }
  if (!text.trim()) throw httpError(400, 'empty extract');
  const bookTitle = titleFromFilename(filename);
  const book = await addBook(libraryDir, {
    title: bookTitle,
    source: { kind: 'pdf', label: filename },
    chapters: splitPlainText(text, bookTitle),
  });
  return { text, book };
}

async function importHtml(libraryDir, payload) {
  const filename = basenameOrThrow(payload.filename, 'html import requires filename');
  if (typeof payload.html !== 'string') throw httpError(400, 'html import requires html');
  const extracted = extractHtml(payload.html);
  if (!extracted.text.trim()) throw httpError(400, 'empty extract');
  const bookTitle = extracted.documentTitle || titleFromFilename(filename);
  const book = await addBook(libraryDir, {
    title: bookTitle,
    source: { kind: 'web', label: filename },
    chapters: extracted.chapters,
  });
  return { text: extracted.text, book };
}

async function importUrl(libraryDir, payload, fetchImpl) {
  if (typeof payload.url !== 'string' || payload.url.trim() === '') {
    throw httpError(400, 'web import requires html or url');
  }
  let target;
  try {
    target = new URL(payload.url);
  } catch {
    throw httpError(400, 'invalid url');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw httpError(400, 'url must be http or https');
  }
  const fetchFn = fetchImpl || globalThis.fetch;
  let response;
  try {
    response = await fetchFn(target.href, {
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
  } catch {
    throw httpError(400, 'could not fetch url');
  }
  if (!response.ok) throw httpError(400, 'could not fetch url');
  const html = await response.text();
  const extracted = extractHtml(html);
  if (!extracted.text.trim()) throw httpError(400, 'empty extract');
  const book = await addBook(libraryDir, {
    title: `${target.hostname}${target.pathname}`,
    source: { kind: 'web', label: payload.url },
    chapters: extracted.chapters,
  });
  return { text: extracted.text, book };
}

async function importDocument(libraryDir, payload, fetchImpl) {
  if (payload.kind === 'pdf') return importPdf(libraryDir, payload);
  if (payload.kind === 'web') {
    if (typeof payload.html === 'string') return importHtml(libraryDir, payload);
    return importUrl(libraryDir, payload, fetchImpl);
  }
  throw httpError(400, 'kind must be pdf or web');
}

function requireId(value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw httpError(404, 'not found');
  return value;
}

async function sendSegmentAudio(res, libraryDir, bookId, chapterId, segmentId, download) {
  const book = await getBook(libraryDir, bookId);
  if (!book) throw httpError(404, 'book not found');
  const chapter = book.chapters.find((item) => item.id === chapterId);
  if (!chapter) throw httpError(404, 'chapter not found');
  const segment = (chapter.segments || []).find((item) => item.id === segmentId);
  if (!segment) throw httpError(404, 'segment not found');
  const filePath = path.join(libraryDir, 'audio', bookId, chapterId, `${segmentId}.wav`);
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') throw httpError(404, 'audio not ready');
    throw error;
  }
  const disposition = download
    ? `attachment; filename="${segmentId}.wav"`
    : 'inline';
  res.writeHead(200, {
    'content-type': 'audio/wav',
    'content-length': bytes.length,
    'content-disposition': disposition,
    'cache-control': 'no-store',
  });
  res.end(bytes);
}

function sendStatic(res, spec) {
  const stream = createReadStream(spec.file);
  stream.on('error', () => {
    if (!res.headersSent) sendJson(res, 404, { error: 'not found' });
  });
  res.writeHead(200, { 'content-type': spec.type, 'cache-control': 'no-store' });
  stream.pipe(res);
}

async function ttsStatus(libraryDir) {
  const settings = await readTtsSettings(libraryDir);
  const voiceConfigured = await hasVoiceRef(libraryDir);
  return {
    voiceConfigured,
    tts: {
      baseUrl: settings.baseUrl,
      lang: settings.lang,
      durationFactor: settings.durationFactor,
      voiceName: voiceConfigured ? settings.voiceName : '',
      voiceConfigured,
    },
  };
}

async function handle(req, res, context) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const { libraryDir, fetchImpl, synthesizer } = context;

  if (req.method === 'GET' && STATIC[pathname]) {
    sendStatic(res, STATIC[pathname]);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/import') {
    const payload = await readJson(req);
    const result = await importDocument(libraryDir, payload, fetchImpl);
    sendJson(res, 201, { text: result.text, book: presentBook(result.book) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/voice') {
    const payload = await readJson(req);
    if (typeof payload.wavBase64 !== 'string' || payload.wavBase64.trim() === '') {
      throw httpError(400, 'voice upload requires wavBase64');
    }
    const bytes = Buffer.from(payload.wavBase64, 'base64');
    if (bytes.length === 0) throw httpError(400, 'empty wav');
    await saveVoiceRef(libraryDir, bytes, payload.filename);
    sendJson(res, 200, await ttsStatus(libraryDir));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/tts') {
    const payload = await readJson(req);
    await saveTtsSettings(libraryDir, {
      baseUrl: payload.baseUrl,
      lang: payload.lang,
      durationFactor: payload.durationFactor,
    });
    sendJson(res, 200, await ttsStatus(libraryDir));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/tts/test') {
    const settings = await readTtsSettings(libraryDir);
    const result = await testIndexTts(settings.baseUrl, fetchImpl || globalThis.fetch);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/tts/preview') {
    const payload = await readJson(req);
    const text = String(payload.text || '这是 Index-TTS 的音色试听。').trim();
    if (!text || text.length > 80) throw httpError(400, '试听一句最多 80 字');
    const wav = await previewVoice(libraryDir, text);
    res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
    res.end(wav);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/library') {
    const registry = await readRegistry(libraryDir);
    const status = await ttsStatus(libraryDir);
    sendJson(res, 200, {
      books: registry.books.map(presentBook),
      voiceConfigured: status.voiceConfigured,
      tts: status.tts,
    });
    return;
  }

  const bookMatch = pathname.match(/^\/api\/books\/([^/]+)$/);
  if (req.method === 'GET' && bookMatch) {
    const book = await getBook(libraryDir, requireId(decodeURIComponent(bookMatch[1])));
    if (!book) throw httpError(404, 'book not found');
    sendJson(res, 200, { book: presentBook(book) });
    return;
  }

  const generateBookMatch = pathname.match(/^\/api\/books\/([^/]+)\/generate$/);
  if (req.method === 'POST' && generateBookMatch) {
    const bookId = requireId(decodeURIComponent(generateBookMatch[1]));
    const book = await generateBook(libraryDir, bookId, { synthesizer });
    sendJson(res, 200, { book: presentBook(book) });
    return;
  }

  const generateChapterMatch = pathname.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/generate$/);
  if (req.method === 'POST' && generateChapterMatch) {
    const bookId = requireId(decodeURIComponent(generateChapterMatch[1]));
    const chapterId = requireId(decodeURIComponent(generateChapterMatch[2]));
    const book = await generateChapter(libraryDir, bookId, chapterId, { synthesizer });
    sendJson(res, 200, { book: presentBook(book) });
    return;
  }

  const segmentAudioMatch = pathname.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/segments\/([^/]+)\/audio$/);
  if (req.method === 'GET' && segmentAudioMatch) {
    const bookId = requireId(decodeURIComponent(segmentAudioMatch[1]));
    const chapterId = requireId(decodeURIComponent(segmentAudioMatch[2]));
    const segmentId = requireId(decodeURIComponent(segmentAudioMatch[3]));
    await sendSegmentAudio(
      res,
      libraryDir,
      bookId,
      chapterId,
      segmentId,
      url.searchParams.get('download') === '1',
    );
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

export async function startServer({
  port = 0,
  host = '127.0.0.1',
  libraryDir,
  fetchImpl,
  synthesizer,
} = {}) {
  if (!libraryDir) throw new Error('libraryDir is required');
  await mkdir(libraryDir, { recursive: true });
  const server = http.createServer((req, res) => {
    handle(req, res, { libraryDir, fetchImpl, synthesizer }).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = Number.isInteger(error.status) ? error.status : 500;
      sendJson(res, status, { error: error.message || 'server error' });
    });
  });
  await new Promise((resolve) => {
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    host: address.address,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  const port = Number(process.env.PORT || 4173);
  const libraryDir = process.env.LIBRARY_DIR
    ? path.resolve(process.env.LIBRARY_DIR)
    : path.join(rootDir, 'data');
  const started = await startServer({ port, libraryDir });
  console.log(`listening on ${started.url}`);
}
