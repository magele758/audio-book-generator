import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { synthesizeIndexTts } from './indextts.js';
import { splitParagraphs } from './paragraphs.js';
import { synthesizeToFile } from './synthesize.js';

const SEGMENT_CHARS = 320;

let writeQueue = Promise.resolve();
let progressWriteQueue = Promise.resolve();
const registryCache = new Map();

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function registryPath(dir) {
  return path.join(dir, 'library.json');
}

const TTS_LANGS = ['ZH', 'EN', 'JA', 'AR', 'ES'];

function normalizeTtsUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').replace(/\/gradio_api$/i, '');
}

function voiceRefPath(dir) {
  return path.join(dir, 'voice-ref.wav');
}

function ttsSettingsPath(dir) {
  return path.join(dir, 'tts.json');
}

function progressPath(dir) {
  return path.join(dir, 'progress.json');
}

export async function readProgress(dir) {
  try {
    const raw = await readFile(progressPath(dir), 'utf8');
    const parsed = JSON.parse(raw);
    const books = parsed && typeof parsed.books === 'object' && !Array.isArray(parsed.books) && parsed.books !== null
      ? parsed.books
      : {};
    const lastBookId = typeof parsed?.lastBookId === 'string' ? parsed.lastBookId : '';
    return { books, lastBookId };
  } catch (error) {
    if (error.code === 'ENOENT') return { books: {}, lastBookId: '' };
    return { books: {}, lastBookId: '' };
  }
}

export function saveBookProgress(dir, bookId, input = {}) {
  const run = progressWriteQueue.then(async () => {
    const state = await readProgress(dir);
    const updatedAtRaw = Number(input.updatedAt);
    const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0
      ? Math.floor(updatedAtRaw)
      : Date.now();
    const timeRaw = Number(input.currentTime);
    const entry = {
      chapterId: String(input.chapterId || ''),
      chapterIndex: Math.max(0, Math.floor(Number(input.chapterIndex) || 0)),
      segmentId: String(input.segmentId || ''),
      segmentIndex: Math.max(0, Math.floor(Number(input.segmentIndex) || 0)),
      currentTime: Math.round(Math.max(0, Number.isFinite(timeRaw) ? timeRaw : 0) * 100) / 100,
      updatedAt,
    };

    const prevBook = state.books[bookId];
    const prevChapters = prevBook && typeof prevBook.chapters === 'object' && prevBook.chapters !== null && !Array.isArray(prevBook.chapters)
      ? { ...prevBook.chapters }
      : {};

    if (entry.chapterId) {
      const prevChapter = prevChapters[entry.chapterId];
      if (!prevChapter || entry.updatedAt >= (Number(prevChapter.updatedAt) || 0)) {
        prevChapters[entry.chapterId] = { ...entry };
      }
    }

    if (!prevBook || entry.updatedAt >= (Number(prevBook.updatedAt) || 0)) {
      state.books[bookId] = { ...entry, chapters: prevChapters };
    } else {
      state.books[bookId] = { ...prevBook, chapters: prevChapters };
    }

    const prevLastUpdated = Number(state.books[state.lastBookId]?.updatedAt) || 0;
    if (!state.lastBookId || entry.updatedAt >= prevLastUpdated) {
      state.lastBookId = bookId;
    }

    await mkdir(dir, { recursive: true });
    const destination = progressPath(dir);
    const temporary = path.join(dir, `.progress-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temporary, destination);
    return state.books[bookId];
  });
  progressWriteQueue = run.then(() => {}, () => {});
  return run;
}

export async function readTtsSettings(dir) {
  let saved = null;
  try {
    saved = JSON.parse(await readFile(ttsSettingsPath(dir), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lang = TTS_LANGS.includes(saved?.lang) ? saved.lang : 'ZH';
  const factor = Number(saved?.durationFactor);
  const baseUrl = saved && Object.prototype.hasOwnProperty.call(saved, 'baseUrl')
    ? normalizeTtsUrl(saved.baseUrl)
    : normalizeTtsUrl(process.env.INDEX_TTS_URL);
  return {
    baseUrl,
    lang,
    durationFactor: Number.isFinite(factor) && factor > 0 ? factor : 1,
    voiceName: String(saved?.voiceName || ''),
  };
}

export async function saveTtsSettings(dir, input = {}) {
  const current = await readTtsSettings(dir);
  const factor = Number(input.durationFactor);
  const next = {
    baseUrl: input.baseUrl === undefined ? current.baseUrl : normalizeTtsUrl(input.baseUrl),
    lang: TTS_LANGS.includes(input.lang) ? input.lang : current.lang,
    durationFactor: input.durationFactor === undefined
      ? current.durationFactor
      : (Number.isFinite(factor) && factor > 0 ? factor : 1),
    voiceName: input.voiceName === undefined ? current.voiceName : String(input.voiceName || ''),
  };
  await mkdir(dir, { recursive: true });
  const destination = ttsSettingsPath(dir);
  const temporary = path.join(dir, `.tts-${process.pid}-${Date.now()}.json`);
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temporary, destination);
  return next;
}

export async function hasVoiceRef(dir) {
  try {
    await access(voiceRefPath(dir));
    return true;
  } catch {
    return false;
  }
}

export async function deleteVoiceRef(dir) {
  await rm(voiceRefPath(dir), { force: true });
  await saveTtsSettings(dir, { voiceName: '' });
}

export async function clearGeneratedAudio(dir) {
  await mutate(dir, (registry) => {
    for (const book of registry.books) {
      for (const chapter of book.chapters) {
        for (const segment of chapter.segments) {
          segment.audio.status = 'pending';
          segment.audio.bytes = 0;
          segment.audio.error = null;
        }
      }
    }
  });
  await rm(path.join(dir, 'audio'), { recursive: true, force: true });
}

export async function saveVoiceRef(dir, bytes, filename = '') {
  await mkdir(dir, { recursive: true });
  const destination = voiceRefPath(dir);
  const temporary = path.join(dir, `.voice-${process.pid}-${Date.now()}.wav`);
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
  const voiceName = path.basename(String(filename || 'ref.wav'));
  await saveTtsSettings(dir, { voiceName });
}

export async function previewVoice(dir, text) {
  const settings = await readTtsSettings(dir);
  if (!settings.baseUrl) throw httpError(400, '先填写 Index-TTS 地址');
  let referenceWav = null;
  try {
    referenceWav = await readFile(voiceRefPath(dir));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return synthesizeIndexTts({
    baseUrl: settings.baseUrl,
    text,
    referenceWav,
    lang: settings.lang,
    durationFactor: settings.durationFactor,
  });
}

export async function readRegistry(dir) {
  const filePath = registryPath(dir);
  try {
    const info = await stat(filePath);
    const cached = registryCache.get(filePath);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached.data;
    }
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const data = parsed && Array.isArray(parsed.books) ? parsed : { books: [] };
    registryCache.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, data });
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') {
      registryCache.delete(filePath);
      return { books: [] };
    }
    throw error;
  }
}

async function writeRegistry(dir, registry) {
  await mkdir(dir, { recursive: true });
  const destination = registryPath(dir);
  const temporary = path.join(dir, `.library-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`);
  await rename(temporary, destination);
  try {
    const info = await stat(destination);
    registryCache.set(destination, { mtimeMs: info.mtimeMs, size: info.size, data: registry });
  } catch {
    registryCache.delete(destination);
  }
}

function mutate(dir, fn) {
  const run = writeQueue.then(async () => {
    const registry = structuredClone(await readRegistry(dir));
    await fn(registry);
    await writeRegistry(dir, registry);
    return registry;
  });
  writeQueue = run.then(() => {}, () => {});
  return run;
}

function segmentRecord(bookId, chapterId, text, index) {
  const id = crypto.randomUUID();
  return {
    id,
    index,
    text,
    audio: {
      status: 'pending',
      relativePath: `audio/${bookId}/${chapterId}/${id}.wav`,
      mime: 'audio/wav',
      bytes: 0,
      error: null,
    },
  };
}

function buildSegments(bookId, chapterId, title, text) {
  const parts = splitParagraphs(text, { maxChars: SEGMENT_CHARS });
  const lines = parts.length > 0 ? parts : [String(title ?? '')];
  return lines.map((line, index) => segmentRecord(bookId, chapterId, line, index));
}

export async function addBook(dir, input) {
  const id = crypto.randomUUID();
  const chapters = input.chapters.map((chapter, index) => {
    const chapterId = crypto.randomUUID();
    return {
      id: chapterId,
      index,
      title: chapter.title,
      text: chapter.text,
      segments: buildSegments(id, chapterId, chapter.title, chapter.text),
    };
  });
  const book = {
    id,
    title: input.title,
    source: { kind: input.source.kind, label: input.source.label },
    chapters,
  };
  await mutate(dir, (registry) => {
    registry.books.push(book);
  });
  return book;
}

export async function getBook(dir, bookId) {
  const registry = await readRegistry(dir);
  return registry.books.find((book) => book.id === bookId) || null;
}

function findChapter(registry, bookId, chapterId) {
  const book = registry.books.find((item) => item.id === bookId);
  if (!book) throw httpError(404, 'book not found');
  const chapter = book.chapters.find((item) => item.id === chapterId);
  if (!chapter) throw httpError(404, 'chapter not found');
  return chapter;
}

function findSegment(registry, bookId, chapterId, segmentId) {
  const chapter = findChapter(registry, bookId, chapterId);
  const segment = chapter.segments.find((item) => item.id === segmentId);
  if (!segment) throw httpError(404, 'segment not found');
  return segment;
}

async function runSegment(dir, bookId, chapterId, segment, synthesizer, signal) {
  if (signal?.aborted) return null;
  const relativePath = `audio/${bookId}/${chapterId}/${segment.id}.wav`;
  const filePath = path.join(dir, relativePath);
  try {
    const bytes = await synthesizer(segment.text, filePath, signal);
    if (signal?.aborted) return null;
    let audioMeta = null;
    await mutate(dir, (registry) => {
      const found = findSegment(registry, bookId, chapterId, segment.id);
      found.audio.status = 'ready';
      found.audio.relativePath = relativePath;
      found.audio.mime = 'audio/wav';
      found.audio.bytes = Number.isFinite(bytes) ? bytes : found.audio.bytes;
      found.audio.error = null;
      audioMeta = {
        status: found.audio.status,
        bytes: found.audio.bytes,
        error: found.audio.error,
      };
    });
    return {
      chapterId,
      segmentId: segment.id,
      segmentIndex: segment.index,
      audio: audioMeta,
    };
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return null;
    let audioMeta = null;
    await mutate(dir, (registry) => {
      const found = findSegment(registry, bookId, chapterId, segment.id);
      found.audio.status = 'failed';
      found.audio.error = error instanceof Error ? error.message : String(error);
      found.audio.bytes = 0;
      audioMeta = {
        status: found.audio.status,
        bytes: found.audio.bytes,
        error: found.audio.error,
      };
    });
    return {
      chapterId,
      segmentId: segment.id,
      segmentIndex: segment.index,
      audio: audioMeta,
    };
  }
}

async function resolveSynthesizer(dir, options) {
  if (typeof options.synthesizer === 'function') return options.synthesizer;
  const settings = await readTtsSettings(dir);
  if (!settings.baseUrl) return synthesizeToFile;
  let referenceWav = null;
  try {
    referenceWav = await readFile(voiceRefPath(dir));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return async (text, filePath, signal) => {
    const buffer = await synthesizeIndexTts({
      baseUrl: settings.baseUrl,
      text,
      referenceWav,
      lang: settings.lang,
      durationFactor: settings.durationFactor,
      signal,
    });
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
    return buffer.length;
  };
}

async function synthesizeSegments(dir, bookId, jobs, synthesizer, signal) {
  // Index-TTS is one GPU, so segments run one at a time.
  const updated = [];
  for (const segment of jobs) {
    if (signal?.aborted) break;
    const item = await runSegment(dir, bookId, segment.chapterId, segment, synthesizer, signal);
    if (item) updated.push(item);
  }
  return updated;
}

function pendingJobs(chapters, { fromSegmentIndex = 0, skipFailed = false } = {}) {
  const jobs = chapters.flatMap((chapter) => chapter.segments
    .filter((segment) => {
      const st = segment.audio?.status;
      if (st === 'ready') return false;
      if (skipFailed && st === 'failed') return false;
      return true;
    })
    .map((segment) => ({
      chapterId: chapter.id,
      id: segment.id,
      index: segment.index,
      text: segment.text,
    })));

  if (chapters.length === 1 && Number.isInteger(fromSegmentIndex) && fromSegmentIndex > 0) {
    const ahead = [];
    const behind = [];
    for (const job of jobs) {
      if (job.index >= fromSegmentIndex) ahead.push(job);
      else behind.push(job);
    }
    return [...ahead, ...behind];
  }
  return jobs;
}

function limitedJobs(jobs, limit) {
  if (!Number.isFinite(limit)) return jobs;
  return jobs.slice(0, limit);
}

export function pendingCount(book, chapterId) {
  const chapters = chapterId
    ? book.chapters.filter((chapter) => chapter.id === chapterId)
    : book.chapters;
  return pendingJobs(chapters).length;
}

export async function generateBook(dir, bookId, options = {}) {
  const book = await getBook(dir, bookId);
  if (!book) throw httpError(404, 'book not found');
  if (options.signal?.aborted) return options.returnDelta ? { book, updatedSegments: [] } : book;
  const synthesizer = await resolveSynthesizer(dir, options);
  const jobs = limitedJobs(pendingJobs(book.chapters, { skipFailed: options.skipFailed }), options.limit);
  const updatedSegments = await synthesizeSegments(dir, bookId, jobs, synthesizer, options.signal);
  const updatedBook = await getBook(dir, bookId);
  return options.returnDelta ? { book: updatedBook, updatedSegments } : updatedBook;
}

export async function generateChapter(dir, bookId, chapterId, options = {}) {
  const book = await getBook(dir, bookId);
  if (!book) throw httpError(404, 'book not found');
  const chapter = book.chapters.find((item) => item.id === chapterId);
  if (!chapter) throw httpError(404, 'chapter not found');
  if (options.signal?.aborted) return options.returnDelta ? { book, updatedSegments: [] } : book;
  const synthesizer = await resolveSynthesizer(dir, options);
  const jobs = limitedJobs(
    pendingJobs([chapter], {
      fromSegmentIndex: options.fromSegmentIndex,
      skipFailed: options.skipFailed,
    }),
    options.limit,
  );
  const updatedSegments = await synthesizeSegments(dir, bookId, jobs, synthesizer, options.signal);
  const updatedBook = await getBook(dir, bookId);
  return options.returnDelta ? { book: updatedBook, updatedSegments } : updatedBook;
}
