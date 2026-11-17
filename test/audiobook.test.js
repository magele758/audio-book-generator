import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { splitPlainText } from '../src/chapters.js';
import { extractHtml } from '../src/extract.js';
import { generateBook, generateChapter, readRegistry } from '../src/library.js';
import { createPlayer } from '../src/player.js';
import { startServer } from '../src/server.js';
import { renderWav, synthesizeToFile } from '../src/synthesize.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const pdfFixture = new URL('./fixtures/two-chapters.pdf', import.meta.url);
const htmlFixture = new URL('./fixtures/two-chapters.html', import.meta.url);
const mvpSentence = 'MVP机制：使用 pdfjs-dist 抽取 PDF 文本；网页支持 HTML 文件与 http(s) URL；章节按标题规则自动切分；每个章节由本地合成器写成 WAV；资料库是 data/library.json 加上 data/audio 中的文件；Web 播放器用章节音频 URL 直接播放。';
const decidedLines = [
  '输入仅 PDF 与网页 HTML，本阶段不支持其他文本格式。',
  '章节只按标题规则自动识别，不支持人工标注。',
  '本阶段不训练声音模型；朗读音频由本地 WAV 合成器生成。',
  'Web 端包含导入、章节预览、资料库列表、播放和下载，不包含删除。',
  '生成单位是章节音频文件，播放器按章节顺序播放，不生成整本书单条长音频。',
];

function assertPlayableWav(buffer) {
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buffer.readUInt16LE(20), 1);
  assert.equal(buffer.readUInt16LE(22), 1);
  assert.equal(buffer.readUInt32LE(24), 22050);
  assert.equal(buffer.readUInt16LE(34), 16);
  const dataAt = buffer.indexOf('data');
  assert.ok(dataAt >= 36);
  const dataSize = buffer.readUInt32LE(dataAt + 4);
  assert.ok(dataSize > 0);
  const pcm = buffer.subarray(dataAt + 8, dataAt + 8 + dataSize);
  assert.equal(pcm.length, dataSize);
  let loud = false;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    if (pcm.readInt16LE(offset) !== 0) {
      loud = true;
      break;
    }
  }
  assert.equal(loud, true);
  const seconds = dataSize / 2 / 22050;
  assert.ok(seconds >= 0.4 && seconds <= 30);
}

async function wavFiles(dir) {
  const found = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(full);
    }
  }
  await walk(path.join(dir, 'audio'));
  return found;
}

async function withServer(fn, fetchImpl) {
  const dir = await mkdtemp(path.join(tmpdir(), 'audiobook-'));
  const server = await startServer({ libraryDir: dir, fetchImpl });
  try {
    assert.equal(server.host, '127.0.0.1');
    assert.equal(server.port > 0, true);
    await fn({ base: server.url, dir });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function postJson(base, pathname, payload) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  return { response, body };
}

describe('audiobook mvp', { concurrency: false, timeout: 60000 }, () => {
  test('pdf import returns both fixture bodies and exactly two chapters', async () => {
    const pdf = await readFile(pdfFixture);
    await withServer(async ({ base, dir }) => {
      const { response, body } = await postJson(base, '/api/import', {
        kind: 'pdf',
        filename: 'two-chapters.pdf',
        pdfBase64: pdf.toString('base64'),
      });
      assert.equal(response.status, 201);
      assert.match(body.text, /Alpha body from the pdf fixture\./);
      assert.match(body.text, /Beta body from the pdf fixture\./);
      assert.equal(body.book.title, 'two-chapters');
      assert.deepEqual(body.book.source, { kind: 'pdf', label: 'two-chapters.pdf' });
      assert.equal(body.book.audio, undefined);
      assert.equal(body.book.chapters.length, 2);
      assert.equal(body.book.chapters[0].title, 'Chapter 1 Start');
      assert.equal(body.book.chapters[1].title, 'Chapter 2 Next');
      assert.match(body.book.chapters[0].preview, /Alpha body from the pdf fixture\./);
      assert.match(body.book.chapters[1].preview, /Beta body from the pdf fixture\./);
      assert.equal(body.book.chapters[0].index, 0);
      assert.equal(body.book.chapters[1].index, 1);
      assert.deepEqual(await wavFiles(dir), []);
    });
  });

  test('html import drops the script and returns two web chapters', async () => {
    const html = await readFile(htmlFixture, 'utf8');
    await withServer(async ({ base }) => {
      const { response, body } = await postJson(base, '/api/import', {
        kind: 'web',
        filename: 'two-chapters.html',
        html,
      });
      assert.equal(response.status, 201);
      assert.match(body.text, /Alpha body from the web fixture\./);
      assert.match(body.text, /Beta body from the web fixture\./);
      assert.equal(body.text.includes('secret should not appear'), false);
      assert.equal(body.book.title, 'Fixture Page');
      assert.equal(body.book.chapters.length, 2);
      assert.equal(body.book.chapters[0].title, 'Chapter 1 Opening');
      assert.equal(body.book.chapters[1].title, 'Chapter 2 Later');
      assert.match(body.book.chapters[0].preview, /Alpha body from the web fixture\./);
      assert.match(body.book.chapters[1].preview, /Beta body from the web fixture\./);
      assert.equal(body.book.audio, undefined);
    });
  });

  test('url import uses the injected fetch and keeps book order', async () => {
    const html = await readFile(htmlFixture, 'utf8');
    const pdf = await readFile(pdfFixture);
    let fetches = 0;
    await withServer(async ({ base }) => {
      const web = await postJson(base, '/api/import', {
        kind: 'web',
        url: 'https://fixtures.example/books/two',
      });
      assert.equal(web.response.status, 201);
      assert.equal(fetches, 1);
      assert.match(web.body.text, /Alpha body from the web fixture\./);
      assert.match(web.body.text, /Beta body from the web fixture\./);
      assert.equal(web.body.text.includes('secret should not appear'), false);
      assert.equal(web.body.book.title, 'fixtures.example/books/two');
      assert.equal(web.body.book.chapters.length, 2);
      const file = await postJson(base, '/api/import', {
        kind: 'pdf',
        filename: 'two-chapters.pdf',
        pdfBase64: pdf.toString('base64'),
      });
      assert.equal(file.response.status, 201);
      const listed = await fetch(`${base}/api/library`);
      const library = await listed.json();
      assert.deepEqual(library.books.map((book) => book.id), [web.body.book.id, file.body.book.id]);
    }, async (url, options) => {
      fetches += 1;
      assert.equal(url, 'https://fixtures.example/books/two');
      assert.ok(options.signal);
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    });
  });

  test('a heading-free string becomes one chapter', () => {
    const chapters = splitPlainText('Just a paragraph with no heading.', '');
    assert.equal(chapters.length, 1);
    assert.equal(chapters[0].title, 'Chapter 1');
    assert.equal(chapters[0].text, 'Just a paragraph with no heading.');
    const titled = splitPlainText('plain body', 'Notes');
    assert.equal(titled.length, 1);
    assert.equal(titled[0].title, 'Notes');
    const chinese = splitPlainText('前言\n第一章 甲\n甲的正文\n第二章 乙\n乙的正文\n', '书');
    assert.equal(chinese.length, 2);
    assert.equal(chinese[0].title, '第一章 甲');
    assert.match(chinese[0].text, /甲的正文/);
    assert.equal(chinese[1].title, '第二章 乙');
    const markdown = splitPlainText('# 甲\n甲文\n## 乙\n乙文\n', '书');
    assert.equal(markdown.length, 2);
    assert.equal(markdown[0].title, '甲');
    assert.match(markdown[0].text, /甲文/);
    const html = extractHtml('<html><head><title>Only</title></head><body><h2>A</h2><p>alpha</p><h2>B</h2><p>beta</p></body></html>');
    assert.equal(html.chapters.length, 2);
    assert.equal(html.chapters[0].title, 'A');
    assert.match(html.chapters[0].text, /alpha/);
  });

  test('batch generate writes two playable wavs and the library lists them', async () => {
    const pdf = await readFile(pdfFixture);
    await withServer(async ({ base, dir }) => {
      const imported = await postJson(base, '/api/import', {
        kind: 'pdf',
        filename: 'two-chapters.pdf',
        pdfBase64: pdf.toString('base64'),
      });
      const bookId = imported.body.book.id;
      const generated = await postJson(base, `/api/books/${bookId}/generate`, {});
      assert.equal(generated.response.status, 200);
      assert.equal(generated.body.book.chapters.length, 2);
      assert.equal(generated.body.book.audio, undefined);
      for (const chapter of generated.body.book.chapters) {
        assert.equal(chapter.audio.status, 'ready');
        assert.equal(chapter.audio.mime, 'audio/wav');
        assert.ok(chapter.audio.bytes > 0);
        assert.equal(chapter.audio.error, null);
        const audio = await fetch(`${base}/api/books/${bookId}/chapters/${chapter.id}/audio`);
        assert.equal(audio.status, 200);
        assert.equal(audio.headers.get('content-type'), 'audio/wav');
        assert.match(audio.headers.get('content-disposition') || '', /inline/i);
        assertPlayableWav(Buffer.from(await audio.arrayBuffer()));
        const download = await fetch(`${base}/api/books/${bookId}/chapters/${chapter.id}/audio?download=1`);
        assert.equal(download.status, 200);
        assert.equal(download.headers.get('content-type'), 'audio/wav');
        assert.match(download.headers.get('content-disposition') || '', /attachment/i);
        assert.equal((download.headers.get('content-disposition') || '').includes('inline'), false);
      }
      const registry = await readRegistry(dir);
      assert.deepEqual(Object.keys(registry), ['books']);
      assert.equal(registry.books.length, 1);
      assert.equal(registry.books[0].id, bookId);
      assert.equal(registry.books[0].chapters.length, 2);
      for (const chapter of registry.books[0].chapters) {
        assert.deepEqual(Object.keys(chapter).sort(), ['audio', 'id', 'index', 'text', 'title']);
        assert.deepEqual(Object.keys(chapter.audio).sort(), ['bytes', 'error', 'mime', 'relativePath', 'status']);
        assert.equal(chapter.audio.status, 'ready');
        assert.equal(chapter.audio.relativePath, `audio/${bookId}/${chapter.id}.wav`);
        assert.equal(chapter.preview, undefined);
      }
      const files = await wavFiles(dir);
      assert.equal(files.length, 2);
      assert.deepEqual(
        files.map((file) => path.basename(file)).sort(),
        registry.books[0].chapters.map((chapter) => `${chapter.id}.wav`).sort(),
      );
    });
  });

  test('a thrown synthesizer leaves one chapter failed and retry writes its wav', async () => {
    const pdf = await readFile(pdfFixture);
    await withServer(async ({ base, dir }) => {
      const imported = await postJson(base, '/api/import', {
        kind: 'pdf',
        filename: 'two-chapters.pdf',
        pdfBase64: pdf.toString('base64'),
      });
      const bookId = imported.body.book.id;
      const before = imported.body.book.chapters.map((chapter) => ({
        id: chapter.id,
        text: chapter.text,
      }));
      await generateBook(dir, bookId, {
        synthesizer: async (text, destination) => {
          if (text.includes('Beta')) throw new Error('synth failed');
          return synthesizeToFile(text, destination);
        },
      });
      const failedRegistry = await readRegistry(dir);
      const chapters = failedRegistry.books[0].chapters;
      const ready = chapters.filter((chapter) => chapter.audio.status === 'ready');
      const failed = chapters.filter((chapter) => chapter.audio.status === 'failed');
      assert.equal(ready.length, 1);
      assert.equal(failed.length, 1);
      assert.equal(failed[0].audio.error, 'synth failed');
      assert.equal(failed[0].audio.bytes, 0);
      assert.equal(ready[0].text, before.find((chapter) => chapter.id === ready[0].id).text);
      assert.equal(failed[0].text, before.find((chapter) => chapter.id === failed[0].id).text);
      const filesAfterFailure = await wavFiles(dir);
      assert.equal(filesAfterFailure.length, 1);
      const retried = await generateChapter(dir, bookId, failed[0].id);
      const restored = retried.chapters.find((chapter) => chapter.id === failed[0].id);
      assert.equal(restored.audio.status, 'ready');
      assert.equal(restored.audio.error, null);
      assert.ok(restored.audio.bytes > 0);
      const wav = await readFile(path.join(dir, restored.audio.relativePath));
      assertPlayableWav(wav);
      const sibling = retried.chapters.find((chapter) => chapter.id === ready[0].id);
      assert.equal(sibling.audio.status, 'ready');
      assert.equal(sibling.text, ready[0].text);
    });
  });

  test('batch generation runs at most two chapters at a time', async () => {
    const html = '<html><head><title>Three</title></head><body><h1>One</h1><p>alpha text</p><h1>Two</h1><p>beta text</p><h1>Three</h1><p>gamma text</p></body></html>';
    await withServer(async ({ base, dir }) => {
      const imported = await postJson(base, '/api/import', {
        kind: 'web',
        filename: 'three.html',
        html,
      });
      assert.equal(imported.body.book.chapters.length, 3);
      let active = 0;
      let maxActive = 0;
      await generateBook(dir, imported.body.book.id, {
        synthesizer: async (text, destination) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 40));
          active -= 1;
          return synthesizeToFile(text, destination);
        },
      });
      assert.equal(maxActive, 2);
      const registry = await readRegistry(dir);
      assert.equal(registry.books[0].chapters.every((chapter) => chapter.audio.status === 'ready'), true);
    });
  });

  test('empty extract returns 400 and adds no book', async () => {
    await withServer(async ({ base }) => {
      const empty = await postJson(base, '/api/import', {
        kind: 'web',
        filename: 'empty.html',
        html: '<html><head><title>Empty</title></head><body>   </body></html>',
      });
      assert.equal(empty.response.status, 400);
      const blocked = await postJson(base, '/api/import', {
        kind: 'web',
        url: 'file:///tmp/secret.html',
      });
      assert.equal(blocked.response.status, 400);
      const listed = await fetch(`${base}/api/library`);
      const library = await listed.json();
      assert.deepEqual(library.books, []);
    });
  });

  test('the player points audio.src at the chapter and follows playback', async () => {
    const listeners = new Map();
    const audio = {
      src: '',
      currentTime: 0,
      duration: Number.NaN,
      paused: true,
      pauseCalls: 0,
      playCalls: 0,
      play() {
        this.playCalls += 1;
        this.paused = false;
        return Promise.resolve();
      },
      pause() {
        this.pauseCalls += 1;
        this.paused = true;
      },
      addEventListener(type, fn) {
        const list = listeners.get(type) || [];
        list.push(fn);
        listeners.set(type, list);
      },
      emit(type) {
        for (const fn of listeners.get(type) || []) fn();
      },
    };
    const chapters = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];
    const player = createPlayer({ audio, bookId: 'b1', chapters });
    player.load(0);
    assert.equal(audio.src, '/api/books/b1/chapters/c1/audio');
    player.pause();
    assert.equal(audio.paused, true);
    assert.equal(audio.pauseCalls, 1);
    await player.resume();
    assert.equal(audio.paused, false);
    assert.equal(audio.playCalls, 1);
    audio.currentTime = 5;
    audio.duration = 20;
    assert.deepEqual(player.progress(), { currentTime: 5, duration: 20 });
    assert.equal(player.next(), true);
    assert.equal(audio.src, '/api/books/b1/chapters/c2/audio');
    assert.equal(player.previous(), true);
    assert.equal(audio.src, '/api/books/b1/chapters/c1/audio');
    player.load(1);
    audio.emit('ended');
    assert.equal(audio.src, '/api/books/b1/chapters/c3/audio');
    const last = audio.src;
    audio.emit('ended');
    assert.equal(audio.src, last);
    const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(page, /<audio[\s>]/);
    assert.match(app, /createPlayer/);
    assert.match(app, /player\.load\(/);
    const short = renderWav('');
    const long = renderWav('x'.repeat(10000));
    assertPlayableWav(short);
    assertPlayableWav(long);
    assert.ok(Math.abs((short.length - 44) / 2 / 22050 - 0.4) < 0.001);
    assert.ok(Math.abs((long.length - 44) / 2 / 22050 - 30) < 0.001);
  });

  test('the closed decisions are recorded in PRD.md and 需求.md', async () => {
    const prd = await readFile(path.join(root, 'PRD.md'), 'utf8');
    const requirements = await readFile(path.join(root, '需求.md'), 'utf8');
    const sectionStart = prd.indexOf('### 11.1');
    const sectionEnd = prd.indexOf('### 11.2');
    assert.ok(sectionStart >= 0 && sectionEnd > sectionStart);
    assert.equal(prd.slice(sectionStart, sectionEnd).includes(mvpSentence), true);
    assert.match(requirements, /## 七、已决定/);
    assert.equal(requirements.includes('## 七、待明确问题'), false);
    for (const line of decidedLines) assert.equal(requirements.includes(line), true);
    await withServer(async ({ base }) => {
      const home = await fetch(`${base}/`);
      assert.equal(home.status, 200);
      const html = await home.text();
      assert.match(html, /<audio[\s>]/);
      const player = await fetch(`${base}/player.js`);
      assert.equal(player.status, 200);
      assert.match(await player.text(), /export function createPlayer/);
    });
  });
});
