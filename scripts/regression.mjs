#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pdfFixture = join(root, 'test', 'fixtures', 'two-chapters.pdf');
const htmlFixture = join(root, 'test', 'fixtures', 'two-chapters.html');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function serverEnv(port, libraryDir) {
  const env = {
    PATH: process.env.PATH ?? '',
    PORT: String(port),
    LIBRARY_DIR: libraryDir,
  };
  if (process.env.HOME) env.HOME = process.env.HOME;
  return env;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(2000).then(() => false),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function postJson(base, pathname, payload) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _raw: text };
  }
  return { status: response.status, data };
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _raw: text };
  }
  return { status: response.status, data };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const libraryDir = await mkdtemp(join(tmpdir(), 'audiobook-regression-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let stderr = '';
  const child = spawn(process.execPath, [join(root, 'src', 'server.js')], {
    cwd: root,
    env: serverEnv(port, libraryDir),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8000);
  });
  child.stdout?.on('data', () => {});

  const state = {};
  const steps = [
    ['GET /api/library', async () => {
      const deadline = Date.now() + 20_000;
      let last = 'no response';
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`server exited ${child.exitCode} before library responded\n${stderr}`);
        }
        try {
          const listed = await getJson(`${base}/api/library`);
          if (listed.status === 200 && Array.isArray(listed.data.books)) return;
          last = `HTTP ${listed.status}`;
        } catch (error) {
          last = error instanceof Error ? error.message : String(error);
        }
        await sleep(100);
      }
      throw new Error(`library not ready: ${last}\n${stderr}`);
    }],
    ['POST fixture pdf', async () => {
      const pdfBase64 = (await readFile(pdfFixture)).toString('base64');
      const imported = await postJson(base, '/api/import', {
        kind: 'pdf',
        filename: 'two-chapters.pdf',
        pdfBase64,
      });
      assert(imported.status === 201, `status ${imported.status}`);
      const chapters = imported.data.book?.chapters;
      assert(Array.isArray(chapters) && chapters.length === 2, `chapters ${chapters?.length}`);
      assert(chapters[0].title === 'Chapter 1 Start', `title ${chapters[0].title}`);
      assert(chapters[1].title === 'Chapter 2 Next', `title ${chapters[1].title}`);
      state.pdfBookId = imported.data.book.id;
    }],
    ['POST fixture html', async () => {
      const html = await readFile(htmlFixture, 'utf8');
      const imported = await postJson(base, '/api/import', {
        kind: 'web',
        filename: 'two-chapters.html',
        html,
      });
      assert(imported.status === 201, `status ${imported.status}`);
      const chapters = imported.data.book?.chapters;
      assert(Array.isArray(chapters) && chapters.length === 2, `chapters ${chapters?.length}`);
      const prose = [imported.data.text, ...chapters.map((chapter) => chapter.text)].join('\n');
      assert(!prose.includes('secret should not appear'), 'script text leaked into chapter prose');
    }],
    ['POST generate first book', async () => {
      const generated = await postJson(base, `/api/books/${state.pdfBookId}/generate`, {});
      assert(generated.status === 200, `status ${generated.status}`);
      const chapters = generated.data.book?.chapters;
      assert(Array.isArray(chapters) && chapters.length > 0, 'generate returned no chapters');
      const segments = chapters.flatMap((chapter) => chapter.segments ?? []);
      assert(segments.length > 0, 'generate returned no segments');
      for (const segment of segments) {
        assert(segment.audio?.status === 'ready', `segment ${segment.id} status ${segment.audio?.status}`);
      }
      state.audioPath = `/api/books/${state.pdfBookId}/chapters/${chapters[0].id}/segments/${chapters[0].segments[0].id}/audio`;
    }],
    ['GET segment audio', async () => {
      const response = await fetch(`${base}${state.audioPath}`, { signal: AbortSignal.timeout(10_000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      assert(response.status === 200, `status ${response.status}`);
      assert(bytes.length > 44, `wav length ${bytes.length}`);
      assert(bytes.toString('ascii', 0, 4) === 'RIFF', 'missing RIFF');
      assert(bytes.toString('ascii', 8, 12) === 'WAVE', 'missing WAVE');
    }],
    ['POST empty pdf', async () => {
      const before = await getJson(`${base}/api/library`);
      assert(before.status === 200, `library status ${before.status}`);
      const count = before.data.books.length;
      const rejected = await postJson(base, '/api/import', {
        kind: 'pdf',
        filename: 'empty.pdf',
        pdfBase64: '',
      });
      assert(rejected.status >= 400 && rejected.status < 500, `status ${rejected.status}`);
      const after = await getJson(`${base}/api/library`);
      assert(after.status === 200, `library status ${after.status}`);
      assert(after.data.books.length === count, `books ${count} -> ${after.data.books.length}`);
    }],
  ];

  try {
    for (const [name, run] of steps) {
      try {
        await run();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const wrapped = new Error(detail);
        wrapped.step = name;
        throw wrapped;
      }
      console.log(`PASS  ${name}`);
    }
  } catch (error) {
    const step = error.step ?? 'regression';
    console.error(`FAIL  ${step}`);
    console.error(error instanceof Error ? error.message : error);
    if (stderr.trim()) console.error(stderr.trim());
    process.exitCode = 1;
  } finally {
    await stopChild(child);
    await rm(libraryDir, { recursive: true, force: true });
  }
}

await main();
if (process.exitCode) process.exit(process.exitCode);
