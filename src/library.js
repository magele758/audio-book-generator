import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { synthesizeToFile } from './synthesize.js';

let writeQueue = Promise.resolve();

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function registryPath(dir) {
  return path.join(dir, 'library.json');
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

export async function addBook(dir, input) {
  const id = crypto.randomUUID();
  const chapters = input.chapters.map((chapter, index) => {
    const chapterId = crypto.randomUUID();
    return {
      id: chapterId,
      index,
      title: chapter.title,
      text: chapter.text,
      audio: {
        status: 'pending',
        relativePath: `audio/${id}/${chapterId}.wav`,
        mime: 'audio/wav',
        bytes: 0,
        error: null,
      },
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

function audioFile(dir, bookId, chapterId) {
  return path.join(dir, 'audio', bookId, `${chapterId}.wav`);
}

async function runChapter(dir, bookId, chapter, synthesizer) {
  const relativePath = `audio/${bookId}/${chapter.id}.wav`;
  try {
    const bytes = await synthesizer(chapter.text, audioFile(dir, bookId, chapter.id));
    await mutate(dir, (registry) => {
      const found = findChapter(registry, bookId, chapter.id);
      found.audio.status = 'ready';
      found.audio.relativePath = relativePath;
      found.audio.mime = 'audio/wav';
      found.audio.bytes = Number.isFinite(bytes) ? bytes : found.audio.bytes;
      found.audio.error = null;
    });
  } catch (error) {
    await mutate(dir, (registry) => {
      const found = findChapter(registry, bookId, chapter.id);
      found.audio.status = 'failed';
      found.audio.error = error instanceof Error ? error.message : String(error);
      found.audio.bytes = 0;
    });
  }
}

function findChapter(registry, bookId, chapterId) {
  const book = registry.books.find((item) => item.id === bookId);
  if (!book) throw httpError(404, 'book not found');
  const chapter = book.chapters.find((item) => item.id === chapterId);
  if (!chapter) throw httpError(404, 'chapter not found');
  return chapter;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function generateBook(dir, bookId, options = {}) {
  const book = await getBook(dir, bookId);
  if (!book) throw httpError(404, 'book not found');
  const synthesizer = options.synthesizer || synthesizeToFile;
  const snapshot = book.chapters.map((chapter) => ({ id: chapter.id, text: chapter.text }));
  await mapPool(snapshot, 2, (chapter) => runChapter(dir, bookId, chapter, synthesizer));
  return getBook(dir, bookId);
}

export async function generateChapter(dir, bookId, chapterId, options = {}) {
  const book = await getBook(dir, bookId);
  if (!book) throw httpError(404, 'book not found');
  const chapter = book.chapters.find((item) => item.id === chapterId);
  if (!chapter) throw httpError(404, 'chapter not found');
  const synthesizer = options.synthesizer || synthesizeToFile;
  await runChapter(dir, bookId, { id: chapter.id, text: chapter.text }, synthesizer);
  return getBook(dir, bookId);
}
