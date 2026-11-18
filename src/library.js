import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { synthesizeIndexTts } from './indextts.js';
import { splitParagraphs } from './paragraphs.js';
import { synthesizeToFile } from './synthesize.js';

const SEGMENT_CHARS = 320;

let writeQueue = Promise.resolve();

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
  let referenceWav;
  try {
    referenceWav = await readFile(voiceRefPath(dir));
  } catch (error) {
    if (error.code === 'ENOENT') throw httpError(400, '先上传音色样本');
    throw error;
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
  try {
    const raw = await readFile(registryPath(dir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.books)) return { books: [] };
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { books: [] };
    throw error;
  }
}

async function writeRegistry(dir, registry) {
  await mkdir(dir, { recursive: true });
  const destination = registryPath(dir);
  const temporary = path.join(dir, `.library-${process.pid}-${Date.now()}.json`);
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`);
  await rename(temporary, destination);
}

function mutate(dir, fn) {
  const run = writeQueue.then(async () => {
    const registry = await readRegistry(dir);
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

async function runSegment(dir, bookId, chapterId, segment, synthesizer) {
  const relativePath = `audio/${bookId}/${chapterId}/${segment.id}.wav`;
  const filePath = path.join(dir, relativePath);
  try {
    const bytes = await synthesizer(segment.text, filePath);
    await mutate(dir, (registry) => {
      const found = findSegment(registry, bookId, chapterId, segment.id);
      found.audio.status = 'ready';
      found.audio.relativePath = relativePath;
      found.audio.mime = 'audio/wav';
      found.audio.bytes = Number.isFinite(bytes) ? bytes : found.audio.bytes;
      found.audio.error = null;
    });
  } catch (error) {
    await mutate(dir, (registry) => {
      const found = findSegment(registry, bookId, chapterId, segment.id);
      found.audio.status = 'failed';
      found.audio.error = error instanceof Error ? error.message : String(error);
      found.audio.bytes = 0;
    });
  }
}

async function resolveSynthesizer(dir, options) {
  if (typeof options.synthesizer === 'function') return options.synthesizer;
  const settings = await readTtsSettings(dir);
  if (!settings.baseUrl) return synthesizeToFile;
  let referenceWav;
  try {
    referenceWav = await readFile(voiceRefPath(dir));
  } catch (error) {
    if (error.code === 'ENOENT') throw httpError(400, '先在 Index-TTS 音色里上传参考音');
    throw error;
  }
  return async (text, filePath) => {
    const buffer = await synthesizeIndexTts({
      baseUrl: settings.baseUrl,
      text,
      referenceWav,
      lang: settings.lang,
      durationFactor: settings.durationFactor,
    });
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
    return buffer.length;
  };
}

async function synthesizeSegments(dir, bookId, jobs, synthesizer) {
  // Index-TTS is one GPU, so segments run one at a time.
  for (const segment of jobs) {
    await runSegment(dir, bookId, segment.chapterId, segment, synthesizer);
  }
}

function jobsFor(chapters) {
  return chapters.flatMap((chapter) => chapter.segments.map((segment) => ({
    chapterId: chapter.id,
    id: segment.id,
    text: segment.text,
  })));
}

export async function generateBook(dir, bookId, options = {}) {
  const book = await getBook(dir, bookId);
  if (!book) throw httpError(404, 'book not found');
  const synthesizer = await resolveSynthesizer(dir, options);
  await synthesizeSegments(dir, bookId, jobsFor(book.chapters), synthesizer);
  return getBook(dir, bookId);
}

export async function generateChapter(dir, bookId, chapterId, options = {}) {
  const book = await getBook(dir, bookId);
  if (!book) throw httpError(404, 'book not found');
  const chapter = book.chapters.find((item) => item.id === chapterId);
  if (!chapter) throw httpError(404, 'chapter not found');
  const synthesizer = await resolveSynthesizer(dir, options);
  await synthesizeSegments(dir, bookId, jobsFor([chapter]), synthesizer);
  return getBook(dir, bookId);
}
