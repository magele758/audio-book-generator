import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { confirmLibraryAudioClear } from '../public/library-audio.js';
import { splitPlainText } from '../src/chapters.js';
import { extractHtml } from '../src/extract.js';
import { addBook, generateBook, generateChapter, pendingCount, readRegistry } from '../src/library.js';
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

async function withServer(fn, fetchImplOrOptions) {
  const options = typeof fetchImplOrOptions === 'function'
    ? { fetchImpl: fetchImplOrOptions }
    : (fetchImplOrOptions || {});
  const dir = await mkdtemp(path.join(tmpdir(), 'audiobook-'));
  const server = await startServer({
    libraryDir: dir,
    fetchImpl: options.fetchImpl,
    synthesizer: options.synthesizer,
  });
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

  test('extractHtml extracts only clean article body and strips menus, sidebars, metadata, and tags', () => {
    const sample = `<!DOCTYPE html>
<html lang="zh-CN">
<head><title>某科技新闻 · 站点</title></head>
<body>
  <a class="sr-only" href="#main">跳到正文</a>
  <aside>
    <nav><a href="/">精选</a><a href="/hot">热点榜</a><a href="/saved">收藏</a></nav>
    <div role="radiogroup"><button>深色</button><button>浅色</button></div>
  </aside>
  <main id="main">
    <header>
      <button>返回</button>
      <span>某科技新闻</span>
    </header>
    <article>
      <div class="meta-bar"><span>TechCrunch</span><time datetime="2026-11-19">2026-11-19 08:42</time><span>AI 评分 79</span></div>
      <h1>主标题：测试文章正文提取</h1>
      <p>Subtitle in English for testing.</p>
      <section><div>AI 导读</div><p>这里是真正需要朗读的第一段正文内容。</p></section>
      <section><div>推荐理由</div><p>这里是第二段补充说明正文，应该被保留下来。</p></section>
      <p>来源：<a href="https://example.com">TechCrunch</a> · example.com</p>
      <div class="chips"><a class="chip" href="/t/1">主题一</a><a class="chip" href="/t/2">主题二</a></div>
    </article>
    <aside>
      <button>打开原文</button>
      <section><h2>来源</h2><p>TechCrunch</p></section>
      <section><h2>推荐理由</h2><p>侧栏重复理由</p></section>
      <section><h2>主题</h2><a href="/t/1">主题一</a></section>
    </aside>
  </main>
  <footer><a href="/about">关于我们</a></footer>
</body>
</html>`;
    const extracted = extractHtml(sample);
    assert.equal(extracted.chapters.length, 1);
    assert.equal(extracted.chapters[0].title, '主标题：测试文章正文提取');
    const body = extracted.chapters[0].text;
    assert.match(body, /Subtitle in English for testing\./);
    assert.match(body, /这里是真正需要朗读的第一段正文内容。/);
    assert.match(body, /这里是第二段补充说明正文，应该被保留下来。/);
    for (const noise of ['跳到正文', '热点榜', '打开原文', 'AI 评分', '来源：', '主题一', '主题二', '侧栏重复理由', '关于我们', '2026-11-19']) {
      assert.equal(body.includes(noise), false, `body leaked noise: ${noise}`);
      assert.equal(extracted.text.includes(noise), false, `text leaked noise: ${noise}`);
    }

    const inlineSingle = extractHtml('<article><h1>Title</h1><p>Hello <strong>world</strong> today.</p></article>');
    assert.equal(inlineSingle.chapters[0].text, 'Hello world today.');

    const inlineMulti = extractHtml('<body><h2>One</h2><p>Hello <strong>world</strong> today.</p><h2>Two</h2><p>Second <em>part</em>.</p></body>');
    assert.equal(inlineMulti.chapters[0].text, 'Hello world today.');
    assert.equal(inlineMulti.chapters[1].text, 'Second part.');
  });

  test('batch generate writes one playable wav per segment', async () => {
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
        assert.equal(chapter.audio, undefined);
        assert.ok(chapter.segments.length >= 1);
        for (const segment of chapter.segments) {
          assert.equal(segment.audio.status, 'ready');
          assert.ok(segment.audio.bytes > 0);
          assert.equal(segment.audio.error, null);
          assert.ok(segment.text.length <= 80);
          const audio = await fetch(`${base}/api/books/${bookId}/chapters/${chapter.id}/segments/${segment.id}/audio`);
          assert.equal(audio.status, 200);
          assert.equal(audio.headers.get('content-type'), 'audio/wav');
          assert.match(audio.headers.get('content-disposition') || '', /inline/i);
          assertPlayableWav(Buffer.from(await audio.arrayBuffer()));
          const download = await fetch(`${base}/api/books/${bookId}/chapters/${chapter.id}/segments/${segment.id}/audio?download=1`);
          assert.equal(download.status, 200);
          assert.equal(download.headers.get('content-type'), 'audio/wav');
          assert.match(download.headers.get('content-disposition') || '', /attachment/i);
          assert.equal((download.headers.get('content-disposition') || '').includes('inline'), false);
        }
        const removed = await fetch(`${base}/api/books/${bookId}/chapters/${chapter.id}/audio`);
        assert.equal(removed.status, 404);
      }
      const registry = await readRegistry(dir);
      assert.deepEqual(Object.keys(registry), ['books']);
      assert.equal(registry.books.length, 1);
      assert.equal(registry.books[0].id, bookId);
      assert.equal(registry.books[0].chapters.length, 2);
      const names = [];
      for (const chapter of registry.books[0].chapters) {
        assert.deepEqual(Object.keys(chapter).sort(), ['id', 'index', 'segments', 'text', 'title']);
        assert.equal(chapter.audio, undefined);
        assert.equal(chapter.preview, undefined);
        for (const segment of chapter.segments) {
          assert.deepEqual(Object.keys(segment).sort(), ['audio', 'id', 'index', 'text']);
          assert.deepEqual(Object.keys(segment.audio).sort(), ['bytes', 'error', 'mime', 'relativePath', 'status']);
          assert.equal(segment.audio.status, 'ready');
          assert.equal(segment.audio.relativePath, `audio/${bookId}/${chapter.id}/${segment.id}.wav`);
          names.push(`${segment.id}.wav`);
        }
      }
      const files = await wavFiles(dir);
      assert.equal(files.length, names.length);
      assert.deepEqual(files.map((file) => path.basename(file)).sort(), [...names].sort());
    }, { synthesizer: synthesizeToFile });
  });

  test('a thrown synthesizer leaves one segment failed and retry writes its wav', async () => {
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
      const segments = chapters.flatMap((chapter) => chapter.segments);
      const ready = segments.filter((segment) => segment.audio.status === 'ready');
      const failed = segments.filter((segment) => segment.audio.status === 'failed');
      assert.equal(ready.length, 1);
      assert.equal(failed.length, 1);
      assert.equal(failed[0].audio.error, 'synth failed');
      assert.equal(failed[0].audio.bytes, 0);
      const failedChapter = chapters.find((chapter) => chapter.segments.some((segment) => segment.id === failed[0].id));
      const readyChapter = chapters.find((chapter) => chapter.segments.some((segment) => segment.id === ready[0].id));
      assert.equal(readyChapter.text, before.find((chapter) => chapter.id === readyChapter.id).text);
      assert.equal(failedChapter.text, before.find((chapter) => chapter.id === failedChapter.id).text);
      const filesAfterFailure = await wavFiles(dir);
      assert.equal(filesAfterFailure.length, 1);
      const retried = await generateChapter(dir, bookId, failedChapter.id, { synthesizer: synthesizeToFile });
      const restored = retried.chapters.find((chapter) => chapter.id === failedChapter.id);
      const restoredSegment = restored.segments.find((segment) => segment.id === failed[0].id);
      assert.equal(restoredSegment.audio.status, 'ready');
      assert.equal(restoredSegment.audio.error, null);
      assert.ok(restoredSegment.audio.bytes > 0);
      const wav = await readFile(path.join(dir, restoredSegment.audio.relativePath));
      assertPlayableWav(wav);
      const sibling = retried.chapters.find((chapter) => chapter.id === readyChapter.id);
      assert.equal(sibling.segments.every((segment) => segment.audio.status === 'ready'), true);
      assert.equal(sibling.text, readyChapter.text);
    });
  });

  test('batch generation synthesizes one segment at a time', async () => {
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
      assert.equal(maxActive, 1);
      const registry = await readRegistry(dir);
      assert.equal(registry.books[0].chapters.every((chapter) => (
        chapter.segments.every((segment) => segment.audio.status === 'ready')
      )), true);
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
      assert.equal(library.voiceConfigured, false);
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
    const chapters = [
      { id: 'c1', segments: [{ id: 's1' }, { id: 's2' }] },
      { id: 'c2', segments: [{ id: 's3' }] },
      { id: 'c3', segments: [{ id: 's4' }] },
    ];
    const positions = [];
    const player = createPlayer({
      audio,
      bookId: 'b1',
      chapters,
      onPosition: (position) => positions.push(position),
    });
    player.load(0);
    assert.equal(audio.src, '/api/books/b1/chapters/c1/segments/s1/audio');
    assert.equal(player.index, 0);
    assert.equal(player.segmentIndex, 0);
    assert.deepEqual(positions.at(-1), { chapterIndex: 0, segmentIndex: 0, segmentCount: 2 });
    player.pause();
    assert.equal(audio.paused, true);
    assert.equal(audio.pauseCalls, 1);
    assert.equal(player.playing, false);
    let finishPlay;
    const lateAudio = {
      ...audio,
      paused: true,
      pauseCalls: 0,
      playCalls: 0,
      play() {
        this.playCalls += 1;
        return new Promise((resolve) => {
          finishPlay = () => {
            this.paused = false;
            resolve();
          };
        });
      },
      pause() {
        this.pauseCalls += 1;
        this.paused = true;
      },
      addEventListener() {},
    };
    const latePlayer = createPlayer({
      audio: lateAudio,
      bookId: 'b1',
      chapters,
    });
    latePlayer.load(0);
    const pendingPlay = latePlayer.resume();
    assert.equal(latePlayer.playing, true);
    latePlayer.pause();
    assert.equal(latePlayer.playing, false);
    finishPlay();
    await pendingPlay;
    assert.equal(lateAudio.paused, true);
    assert.equal(lateAudio.pauseCalls, 2);
    await player.resume();
    assert.equal(audio.paused, false);
    assert.equal(audio.playCalls, 1);
    audio.currentTime = 5;
    audio.duration = 20;
    assert.deepEqual(player.progress(), { currentTime: 5, duration: 20 });
    const playsBeforeEnd = audio.playCalls;
    audio.emit('ended');
    assert.equal(audio.src, '/api/books/b1/chapters/c1/segments/s2/audio');
    assert.equal(player.index, 0);
    assert.equal(player.segmentIndex, 1);
    assert.deepEqual(positions.at(-1), { chapterIndex: 0, segmentIndex: 1, segmentCount: 2 });
    assert.equal(audio.playCalls, playsBeforeEnd + 1);
    assert.equal(player.next(), true);
    assert.equal(audio.src, '/api/books/b1/chapters/c2/segments/s3/audio');
    assert.equal(player.index, 1);
    assert.equal(player.segmentIndex, 0);
    assert.equal(player.previous(), true);
    assert.equal(audio.src, '/api/books/b1/chapters/c1/segments/s1/audio');
    player.load(1);
    audio.emit('ended');
    assert.equal(audio.src, '/api/books/b1/chapters/c3/segments/s4/audio');
    const last = audio.src;
    audio.emit('ended');
    assert.equal(audio.src, last);
    assert.equal(player.index, 2);
    assert.equal(player.segmentIndex, 0);
    const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(page, /<audio[\s>]/);
    assert.match(page, /Index-TTS 音色/);
    assert.match(page, /id="tts-url"/);
    assert.match(page, /id="voice-file"/);
    assert.match(page, /短段落/);
    assert.match(app, /createPlayer/);
    assert.match(app, /player\.load\(/);
    assert.match(app, /第 \$\{n\} \/ \$\{m\} 段/);
    assert.match(app, /\/api\/voice/);
    assert.match(app, /player\.playing/);
    assert.match(app, /limit: 1/);
    assert.match(app, /method: 'DELETE'/);
    assert.match(page, /id="delete-voice"/);
    assert.match(page, /id="toggle"/);
    const short = renderWav('');
    const long = renderWav('x'.repeat(10000));
    assertPlayableWav(short);
    assertPlayableWav(long);
    assert.ok(Math.abs((short.length - 44) / 2 / 22050 - 0.4) < 0.001);
    assert.ok(Math.abs((long.length - 44) / 2 / 22050 - 30) < 0.001);
  });

  test('a chapter with two paragraphs becomes two segment wavs', async () => {
    const long = '长'.repeat(120);
    await withServer(async ({ base, dir }) => {
      const created = await addBook(dir, {
        title: 'Two paragraphs',
        source: { kind: 'web', label: 'two.html' },
        chapters: [
          { title: 'Opening', text: 'Alpha paragraph one.\n\nBeta paragraph two.' },
          { title: 'Quiet', text: '   ' },
          { title: 'Long', text: long },
        ],
      });
      assert.equal(created.chapters[0].audio, undefined);
      assert.equal(created.chapters[0].segments.length, 2);
      assert.equal(created.chapters[0].segments[0].index, 0);
      assert.equal(created.chapters[0].segments[1].index, 1);
      assert.equal(created.chapters[0].segments[0].text, 'Alpha paragraph one.');
      assert.equal(created.chapters[0].segments[1].text, 'Beta paragraph two.');
      assert.equal(created.chapters[0].segments[0].audio.status, 'pending');
      assert.equal(created.chapters[0].segments[0].audio.bytes, 0);
      assert.equal(created.chapters[0].segments[0].audio.error, null);
      assert.equal(created.chapters[0].segments[0].audio.mime, 'audio/wav');
      assert.equal(
        created.chapters[0].segments[0].audio.relativePath,
        `audio/${created.id}/${created.chapters[0].id}/${created.chapters[0].segments[0].id}.wav`,
      );
      assert.equal(created.chapters[1].segments.length, 1);
      assert.equal(created.chapters[1].segments[0].text, 'Quiet');
      assert.equal(created.chapters[2].segments.length, 1);
      assert.equal(created.chapters[2].segments[0].text, long);
      await generateBook(dir, created.id, { synthesizer: synthesizeToFile });
      const files = await wavFiles(dir);
      assert.equal(files.length, 4);
      for (const chapter of created.chapters) {
        for (const segment of chapter.segments) {
          const wav = await readFile(path.join(dir, 'audio', created.id, chapter.id, `${segment.id}.wav`));
          assertPlayableWav(wav);
        }
      }
      const shown = await fetch(`${base}/api/books/${created.id}`);
      const body = await shown.json();
      const opening = body.book.chapters[0];
      assert.equal(opening.segments[0].text, 'Alpha paragraph one.');
      assert.equal(opening.segments[1].text, 'Beta paragraph two.');
      const clipped = body.book.chapters[2].segments[0];
      assert.equal(clipped.text.length <= 80, true);
      assert.notEqual(clipped.text, long);
      assert.equal(clipped.fullText, long);
      assert.equal(body.book.chapters[2].text, long);
      assert.equal(clipped.audio.relativePath, undefined);
      const registry = await readRegistry(dir);
      assert.equal(registry.books[0].chapters[2].segments[0].text, long);
    });
  });

  test('chapter generate limit leaves later segments and other chapters pending', async () => {
    await withServer(async ({ base, dir }) => {
      const created = await addBook(dir, {
        title: 'Parts',
        source: { kind: 'web', label: 'parts.html' },
        chapters: [
          { title: 'One', text: 'alpha paragraph one.\n\nbeta paragraph two.' },
          { title: 'Two', text: 'gamma paragraph.' },
        ],
      });
      const firstId = created.chapters[0].id;
      const first = await postJson(base, `/api/books/${created.id}/chapters/${firstId}/generate`, { limit: 1 });
      assert.equal(first.response.status, 200);
      assert.equal(first.body.done, false);
      assert.equal(first.body.pending, 1);
      assert.equal(first.body.book.chapters[0].segments.filter((segment) => segment.audio.status === 'ready').length, 1);
      assert.equal(first.body.book.chapters[1].segments[0].audio.status, 'pending');
      const second = await postJson(base, `/api/books/${created.id}/chapters/${firstId}/generate`, { limit: 1 });
      assert.equal(second.response.status, 200);
      assert.equal(second.body.done, true);
      assert.equal(second.body.pending, 0);
      assert.equal(second.body.book.chapters[0].segments.every((segment) => segment.audio.status === 'ready'), true);
      assert.equal(second.body.book.chapters[1].segments[0].audio.status, 'pending');
      const rejected = await postJson(base, `/api/books/${created.id}/generate`, { limit: 0 });
      assert.equal(rejected.response.status, 400);
    });
  });

  test('aborting generation stops before the next segment and another chapter can start', async () => {
    let started;
    const startedGate = new Promise((resolve) => {
      started = resolve;
    });
    let calls = 0;
    await withServer(async ({ base, dir }) => {
      const created = await addBook(dir, {
        title: 'Stop',
        source: { kind: 'web', label: 'stop.html' },
        chapters: [
          { title: 'One', text: 'alpha paragraph one.\n\nbeta paragraph two.' },
          { title: 'Two', text: 'gamma paragraph.' },
        ],
      });
      const controller = new AbortController();
      const response = fetch(`${base}/api/books/${created.id}/chapters/${created.chapters[0].id}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 2 }),
        signal: controller.signal,
      });
      const startedInTime = await Promise.race([
        startedGate.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      assert.equal(startedInTime, true);
      controller.abort();
      await response.catch(() => {});
      const registry = await readRegistry(dir);
      assert.equal(pendingCount(registry.books[0], created.chapters[0].id), 2);
      assert.equal(registry.books[0].chapters[0].segments.every((segment) => segment.audio.status === 'pending'), true);
      const other = await postJson(base, `/api/books/${created.id}/chapters/${created.chapters[1].id}/generate`, { limit: 1 });
      assert.equal(other.response.status, 200);
      assert.equal(other.body.done, true);
      assert.equal(other.body.book.chapters[1].segments[0].audio.status, 'ready');
      assert.equal(other.body.book.chapters[0].segments.every((segment) => segment.audio.status === 'pending'), true);
    }, {
      synthesizer: async (text, destination, signal) => {
        calls += 1;
        if (calls > 1) return synthesizeToFile(text, destination);
        started();
        const aborted = await Promise.race([
          new Promise((resolve) => {
            if (signal?.aborted) resolve(true);
            else signal?.addEventListener('abort', () => resolve(true), { once: true });
          }),
          new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
        ]);
        assert.equal(aborted, true);
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
    });
  });

  test('the clear confirmation describes scope and cancellation leaves work untouched', async () => {
    let calls = 0;
    const clear = async () => { calls += 1; };
    await confirmLibraryAudioClear((message) => {
      assert.match(message, /所有书籍的已生成音频/);
      assert.match(message, /无法撤销/);
      assert.match(message, /音色样本会保留/);
      return false;
    }, clear);
    assert.equal(calls, 0);
    await confirmLibraryAudioClear(() => true, clear);
    assert.equal(calls, 1);
  });

  test('removing the voice returns to default without changing audio files or the registry', async () => {
    await withServer(async ({ base, dir }) => {
      const created = await addBook(dir, {
        title: 'Voice',
        source: { kind: 'web', label: 'voice.html' },
        chapters: [{ title: 'One', text: 'alpha paragraph one.' }],
      });
      await postJson(base, '/api/tts', { baseUrl: 'https://tts.example' });
      await postJson(base, '/api/voice', {
        filename: 'lydia.wav',
        wavBase64: renderWav('voice').toString('base64'),
      });
      await generateChapter(dir, created.id, created.chapters[0].id, { synthesizer: synthesizeToFile });
      const registry = await readRegistry(dir);
      const segment = registry.books[0].chapters[0].segments[0];
      assert.equal(segment.audio.status, 'ready');
      const file = path.join(dir, segment.audio.relativePath);
      const audio = await readFile(file);
      for (let i = 0; i < 2; i += 1) {
        const removed = await fetch(`${base}/api/voice`, { method: 'DELETE' });
        assert.equal(removed.status, 200);
        const body = await removed.json();
        assert.equal(body.voiceConfigured, false);
        assert.equal(body.tts.voiceName, '');
        assert.equal(body.tts.baseUrl, 'https://tts.example');
        assert.deepEqual(await readRegistry(dir), registry);
        assert.deepEqual(await readFile(file), audio);
        await assert.rejects(readFile(path.join(dir, 'voice-ref.wav')), { code: 'ENOENT' });
      }
    });
  });

  test('clear requires explicit confirmation, clears every book, and preserves the voice and progress', async () => {
    await withServer(async ({ base, dir }) => {
      const route = '/api/library/audio/clear';
      const wav = renderWav('voice');
      await postJson(base, '/api/voice', {
        filename: 'lydia.wav', wavBase64: wav.toString('base64'),
      });
      for (const title of ['One', 'Two']) {
        const book = await addBook(dir, {
          title, source: { kind: 'web', label: title + '.html' },
          chapters: [{ title, text: 'A paragraph.' }],
        });
        await generateBook(dir, book.id, { synthesizer: synthesizeToFile });
        await postJson(base, `/api/books/${book.id}/progress`, {
          chapterId: book.chapters[0].id, currentTime: 1.5,
        });
      }
      const registryPath = path.join(dir, 'library.json');
      const progressPath = path.join(dir, 'progress.json');
      const oldRegistry = await readFile(registryPath);
      const progress = await readFile(progressPath);
      for (const input of [{}, { confirm: true }, { confirm: 'only-this-book' }]) {
        assert.equal((await postJson(base, route, input)).response.status, 400);
      }
      const plain = await fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ confirm: 'all-generated-audio' }),
      });
      assert.equal(plain.status, 415);
      assert.equal((await wavFiles(dir)).length, 2);
      assert.deepEqual(await readFile(registryPath), oldRegistry);

      const resetRegistry = JSON.parse(oldRegistry);
      for (const book of resetRegistry.books) {
        for (const chapter of book.chapters) {
          for (const segment of chapter.segments) {
            Object.assign(segment.audio, { status: 'pending', bytes: 0, error: null });
          }
        }
      }
      for (let i = 0; i < 2; i += 1) {
        const clear = await postJson(base, route, { confirm: 'all-generated-audio' });
        assert.equal(clear.response.status, 200);
        assert.deepEqual(clear.body, { cleared: true });
        assert.equal((await wavFiles(dir)).length, 0);
        assert.deepEqual(await readRegistry(dir), resetRegistry);
        assert.deepEqual(await readFile(path.join(dir, 'voice-ref.wav')), wav);
        assert.deepEqual(await readFile(progressPath), progress);
        const library = await fetch(base + '/api/library').then((response) => response.json());
        assert.equal(library.tts.voiceName, 'lydia.wav');
      }
    });
  });

  test('confirmed clear waits for already-running generation before clearing files', async () => {
    const { promise: started, resolve: markStarted } = Promise.withResolvers();
    const { promise: released, resolve: release } = Promise.withResolvers();
    try {
      await withServer(async ({ base, dir }) => {
        const book = await addBook(dir, {
          title: 'Generating', source: { kind: 'web', label: 'queue.html' },
          chapters: [{ title: 'Chapter', text: 'A paragraph.' }],
        });
        const generating = postJson(base, `/api/books/${book.id}/generate`, {});
        await started;
        const clearing = postJson(base, '/api/library/audio/clear', { confirm: 'all-generated-audio' });
        try {
          const early = await Promise.race([
            clearing.then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), 50)),
          ]);
          assert.equal(early, false);
        } finally {
          release();
          await Promise.all([generating, clearing]);
        }
        assert.equal((await generating).response.status, 200);
        assert.equal((await clearing).response.status, 200);
        assert.equal((await wavFiles(dir)).length, 0);
        assert.equal((await readRegistry(dir)).books[0].chapters[0].segments[0].audio.status, 'pending');
      }, {
        synthesizer: async (text, destination) => {
          markStarted();
          await released;
          return synthesizeToFile(text, destination);
        },
      });
    } finally {
      release();
    }
  });

  test('voice upload marks the library reference configured', async () => {
    await withServer(async ({ base, dir }) => {
      const missing = await postJson(base, '/api/voice', {});
      assert.equal(missing.response.status, 400);
      const wav = renderWav('voice');
      const uploaded = await postJson(base, '/api/voice', { wavBase64: wav.toString('base64') });
      assert.equal(uploaded.response.status, 200);
      assert.equal(uploaded.body.voiceConfigured, true);
      const file = await readFile(path.join(dir, 'voice-ref.wav'));
      assert.equal(file.equals(wav), true);
      const listed = await fetch(`${base}/api/library`);
      const library = await listed.json();
      assert.equal(library.voiceConfigured, true);
      assert.equal(library.tts.voiceName, 'ref.wav');
    });
  });

  test('Index-TTS settings are saved and the connection check uses that address', async () => {
    const seen = [];
    await withServer(async ({ base }) => {
      const saved = await postJson(base, '/api/tts', {
        baseUrl: 'http://tts.test/gradio_api/',
        lang: 'EN',
        durationFactor: 1.2,
      });
      assert.equal(saved.response.status, 200);
      assert.equal(saved.body.tts.baseUrl, 'http://tts.test');
      assert.equal(saved.body.tts.lang, 'EN');
      assert.equal(saved.body.tts.durationFactor, 1.2);
      assert.equal(saved.body.voiceConfigured, false);
      const tested = await postJson(base, '/api/tts/test', {});
      assert.equal(tested.response.status, 200);
      assert.equal(tested.body.ok, true);
      assert.equal(seen[0], 'http://tts.test/gradio_api/info');
    }, async (url) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ named_endpoints: { '/gen_single': {} } }),
      };
    });
  });

  test('player waits on pending segments, recovers after updateChapters, cleans up listeners, and resets on play rejection', async () => {
    const listeners = new Map();
    const audio = {
      src: '',
      paused: true,
      loadCalls: 0,
      playCalls: 0,
      load() {
        this.loadCalls += 1;
      },
      play() {
        this.playCalls += 1;
        this.paused = false;
        return Promise.resolve();
      },
      pause() {
        this.paused = true;
      },
      addEventListener(type, fn) {
        const list = listeners.get(type) || [];
        list.push(fn);
        listeners.set(type, list);
      },
      removeEventListener(type, fn) {
        const list = listeners.get(type) || [];
        listeners.set(type, list.filter((item) => item !== fn));
      },
      emit(type) {
        for (const fn of [...(listeners.get(type) || [])]) fn();
      },
    };
    const waitingPositions = [];
    const initialChapters = [
      {
        id: 'c1',
        segments: [
          { id: 's1', audio: { status: 'ready' } },
          { id: 's2', audio: { status: 'pending' } },
        ],
      },
    ];
    const p1 = createPlayer({
      audio,
      bookId: 'b1',
      chapters: initialChapters,
      onWaiting: (pos) => waitingPositions.push(pos),
    });
    assert.equal(p1.load(0), true);
    await p1.resume();
    assert.equal(p1.playing, true);
    assert.equal(p1.waiting, false);

    audio.emit('ended');
    assert.equal(p1.segmentIndex, 1);
    assert.equal(p1.waiting, true);
    assert.equal(p1.playing, false);
    assert.equal(audio.playCalls, 1);
    assert.deepEqual(waitingPositions.at(-1), { chapterIndex: 0, segmentIndex: 1, segmentCount: 2 });

    const updatedChapters = [
      {
        id: 'c1',
        segments: [
          { id: 's1', audio: { status: 'ready' } },
          { id: 's2', audio: { status: 'ready' } },
        ],
      },
    ];
    p1.updateChapters(updatedChapters);
    assert.equal(p1.reloadCurrent(), true);
    assert.equal(p1.waiting, false);
    await p1.resume();
    assert.equal(p1.playing, true);
    assert.equal(audio.src, '/api/books/b1/chapters/c1/segments/s2/audio');

    p1.destroy();
    assert.equal((listeners.get('ended') || []).length, 0);

    const errors = [];
    const failingAudio = {
      ...audio,
      src: '',
      play() {
        return Promise.reject(new Error('play rejected'));
      },
      addEventListener() {},
      removeEventListener() {},
    };
    const p2 = createPlayer({
      audio: failingAudio,
      bookId: 'b1',
      chapters: updatedChapters,
      onError: (err) => errors.push(err),
    });
    p2.load(0);
    await p2.resume().catch(() => {});
    assert.equal(p2.playing, false);
    assert.equal(errors.length, 1);
  });

  test('saves per-book and per-chapter progress to progress.json and restores deferred startTime seek', async () => {
    await withServer(async ({ base, dir }) => {
      const book = await addBook(dir, {
        title: 'Progress Book',
        source: { kind: 'web', label: 'progress.html' },
        chapters: [
          { title: 'One', text: 'First.\n\nSecond.' },
          { title: 'Two', text: 'Third.' },
        ],
      });
      const ch0 = book.chapters[0];
      const ch1 = book.chapters[1];
      const saved0 = await postJson(base, `/api/books/${book.id}/progress`, {
        chapterId: ch0.id,
        chapterIndex: 0,
        segmentId: ch0.segments[1].id,
        segmentIndex: 1,
        currentTime: 4.5,
        updatedAt: 1000,
      });
      assert.equal(saved0.response.status, 200);
      assert.equal(saved0.body.progress.segmentIndex, 1);
      assert.equal(saved0.body.progress.currentTime, 4.5);

      const saved1 = await postJson(base, `/api/books/${book.id}/progress`, {
        chapterId: ch1.id,
        chapterIndex: 1,
        segmentId: ch1.segments[0].id,
        segmentIndex: 0,
        currentTime: 2.25,
        updatedAt: 2000,
      });
      assert.equal(saved1.response.status, 200);

      const listed = await fetch(`${base}/api/library`);
      const lib = await listed.json();
      assert.equal(lib.progress.lastBookId, book.id);
      assert.equal(lib.progress.books[book.id].chapterId, ch1.id);
      assert.equal(lib.progress.books[book.id].currentTime, 2.25);
      assert.equal(lib.progress.books[book.id].chapters[ch0.id].segmentIndex, 1);
      assert.equal(lib.progress.books[book.id].chapters[ch0.id].currentTime, 4.5);

      const rawProgress = JSON.parse(await readFile(path.join(dir, 'progress.json'), 'utf8'));
      assert.equal(rawProgress.lastBookId, book.id);
    });

    const listeners = new Map();
    const audio = {
      src: '',
      currentTime: 0,
      duration: 0,
      readyState: 0,
      paused: true,
      play() {
        this.paused = false;
        return Promise.resolve();
      },
      pause() {
        this.paused = true;
      },
      addEventListener(type, fn) {
        const list = listeners.get(type) || [];
        list.push(fn);
        listeners.set(type, list);
      },
      removeEventListener(type, fn) {
        const list = listeners.get(type) || [];
        listeners.set(type, list.filter((item) => item !== fn));
      },
      emit(type) {
        for (const fn of [...(listeners.get(type) || [])]) fn();
      },
    };
    const p = createPlayer({
      audio,
      bookId: 'b1',
      chapters: [{ id: 'c1', segments: [{ id: 's1' }, { id: 's2' }] }],
    });
    assert.equal(p.loadSegment(0, 1, { startTime: 4.5 }), true);
    assert.equal(p.pendingSeek, 4.5);
    assert.equal(p.progress().currentTime, 4.5);

    audio.duration = 12;
    audio.readyState = 1;
    audio.emit('loadedmetadata');
    assert.equal(audio.currentTime, 4.5);
    assert.equal(p.pendingSeek, 0);

    audio.readyState = 0;
    audio.duration = 0;
    assert.equal(p.loadSegment(0, 0, { startTime: 20 }), true);
    audio.duration = 5;
    audio.readyState = 1;
    audio.currentTime = 0;
    audio.emit('loadedmetadata');
    assert.equal(audio.currentTime, 4.85);
    p.destroy();
  });

  test('compact lookahead generation prioritizes fromSegmentIndex without returning full book', async () => {
    await withServer(async ({ base, dir }) => {
      const created = await addBook(dir, {
        title: 'Lookahead',
        source: { kind: 'web', label: 'lookahead.html' },
        chapters: [
          { title: 'Ch1', text: 'Zero paragraph.\n\nFirst paragraph.\n\nSecond paragraph.' },
        ],
      });
      const ch = created.chapters[0];
      const res = await postJson(base, `/api/books/${created.id}/chapters/${ch.id}/generate`, {
        limit: 1,
        compact: true,
        fromSegmentIndex: 1,
      });
      assert.equal(res.response.status, 200);
      assert.equal(res.body.book, undefined);
      assert.equal(res.body.bookId, created.id);
      assert.equal(res.body.chapterId, ch.id);
      assert.equal(res.body.done, false);
      assert.equal(res.body.pending, 2);
      assert.equal(res.body.updatedSegments.length, 1);
      assert.equal(res.body.updatedSegments[0].segmentIndex, 1);
      assert.equal(res.body.updatedSegments[0].segmentId, ch.segments[1].id);
      assert.equal(res.body.updatedSegments[0].audio.status, 'ready');

      const registry = await readRegistry(dir);
      const segments = registry.books[0].chapters[0].segments;
      assert.equal(segments[0].audio.status, 'pending');
      assert.equal(segments[1].audio.status, 'ready');
      assert.equal(segments[2].audio.status, 'pending');
    }, { synthesizer: synthesizeToFile });
  });

  test('segment audio endpoint advertises accept-ranges and serves HTTP 206 byte ranges', async () => {
    await withServer(async ({ base, dir }) => {
      const created = await addBook(dir, {
        title: 'RangeTest',
        source: { kind: 'web', label: 'range.html' },
        chapters: [{ title: 'Ch1', text: 'Audio range slice check.' }],
      });
      const ch = created.chapters[0];
      await generateChapter(dir, created.id, ch.id, { synthesizer: synthesizeToFile });
      const audioUrl = `${base}/api/books/${created.id}/chapters/${ch.id}/segments/${ch.segments[0].id}/audio`;

      const fullRes = await fetch(audioUrl);
      assert.equal(fullRes.status, 200);
      assert.equal(fullRes.headers.get('accept-ranges'), 'bytes');
      const fullBuf = Buffer.from(await fullRes.arrayBuffer());
      assert.equal(fullBuf.subarray(0, 4).toString('ascii'), 'RIFF');

      const rangeRes = await fetch(audioUrl, { headers: { range: 'bytes=0-43' } });
      assert.equal(rangeRes.status, 206);
      assert.equal(rangeRes.headers.get('accept-ranges'), 'bytes');
      assert.equal(rangeRes.headers.get('content-range'), `bytes 0-43/${fullBuf.length}`);
      const sliceBuf = Buffer.from(await rangeRes.arrayBuffer());
      assert.equal(sliceBuf.length, 44);
      assert.equal(sliceBuf.equals(fullBuf.subarray(0, 44)), true);
    }, { synthesizer: synthesizeToFile });
  });

  test('player with prefetch=true preloads upcoming ready segments as blob URLs and revokes on destroy', async () => {
    const listeners = new Map();
    const audio = {
      src: '',
      currentTime: 0,
      duration: 0,
      readyState: 0,
      paused: true,
      load() {},
      play() {
        this.paused = false;
        return Promise.resolve();
      },
      pause() {
        this.paused = true;
      },
      addEventListener(type, fn) {
        const list = listeners.get(type) || [];
        list.push(fn);
        listeners.set(type, list);
      },
      removeEventListener(type, fn) {
        const list = listeners.get(type) || [];
        listeners.set(type, list.filter((item) => item !== fn));
      },
      emit(type) {
        for (const fn of [...(listeners.get(type) || [])]) fn();
      },
    };

    const fetched = [];
    const createdBlobs = [];
    const revokedBlobs = [];
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    let blobSeq = 0;
    URL.createObjectURL = (blob) => {
      blobSeq += 1;
      const url = `blob:test-${blobSeq}`;
      createdBlobs.push({ url, size: blob.size });
      return url;
    };
    URL.revokeObjectURL = (url) => {
      revokedBlobs.push(url);
    };

    try {
      const p = createPlayer({
        audio,
        bookId: 'b1',
        prefetch: true,
        fetchImpl: async (url) => {
          fetched.push(url);
          return new Response(new Uint8Array([82, 73, 70, 70]), {
            status: 200,
            headers: { 'content-type': 'audio/wav' },
          });
        },
        chapters: [
          {
            id: 'c1',
            segments: [
              { id: 's0', audio: { status: 'ready' } },
              { id: 's1', audio: { status: 'ready' } },
              { id: 's2', audio: { status: 'ready' } },
            ],
          },
        ],
      });

      assert.equal(p.loadSegment(0, 0), true);
      await new Promise((resolve) => setTimeout(resolve, 25));

      assert.deepEqual(fetched, [
        '/api/books/b1/chapters/c1/segments/s1/audio',
        '/api/books/b1/chapters/c1/segments/s2/audio',
      ]);
      assert.equal(createdBlobs.length, 2);

      audio.emit('ended');
      assert.equal(audio.src, 'blob:test-1');

      p.destroy();
      assert.equal(revokedBlobs.includes('blob:test-1'), true);
      assert.equal(revokedBlobs.includes('blob:test-2'), true);
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
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
