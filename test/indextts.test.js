import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildGenSingleData, synthesizeIndexTts } from '../src/indextts.js';

const origin = 'https://tts.example';
const baseUrl = `${origin}/gradio_api/`;
const wav = Buffer.from('RIFF-reference-wav');
const out = Buffer.from('RIFF-synthesized-wav');
const uploadUrl = `${origin}/gradio_api/upload`;
const plainUploadUrl = `${origin}/upload`;
const callUrl = `${origin}/gradio_api/call/gen_single`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function postedJson(call) {
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(call.init.body);
  assert.equal(Object.hasOwn(body, 'session_hash'), false);
  assert.equal(body.session_hash, undefined);
  return body;
}

describe('buildGenSingleData', () => {
  test('builds the 26-slot payload used by IndexTTS gen_single', () => {
    const promptFile = { path: 'prompt.wav' };
    const data = buildGenSingleData({
      promptFile,
      text: 'hello',
      lang: 'EN',
      durationFactor: 1.25,
    });
    assert.equal(data.length, 26);
    assert.deepEqual(data, [
      'Same as the voice reference',
      promptFile,
      'hello',
      'EN',
      null,
      0.65,
      0, 0, 0, 0, 0, 0, 0, 0,
      '',
      false,
      120,
      1.25,
      true,
      0.8,
      30,
      0.8,
      0.0,
      3,
      10.0,
      1500,
    ]);
  });

  test('switches emotion control and drops invalid lang or duration', () => {
    const emotionFile = { path: 'emo.wav' };
    const data = buildGenSingleData({
      promptFile: { path: 'prompt.wav' },
      text: 'hello',
      lang: 'FR',
      durationFactor: 0,
      emotionFile,
    });
    assert.equal(data[0], 'Use emotion reference audio');
    assert.equal(data[3], 'ZH');
    assert.equal(data[4], emotionFile);
    assert.equal(data[5], 0.8);
    assert.equal(data[17], 1);
    assert.equal(buildGenSingleData({ text: 'a', durationFactor: Number.NaN })[17], 1);
    assert.equal(buildGenSingleData({ text: 'a', durationFactor: -3 })[17], 1);
    for (const lang of ['ZH', 'EN', 'JA', 'AR', 'ES']) {
      assert.equal(buildGenSingleData({ text: 'a', lang })[3], lang);
    }
  });
});

describe('synthesizeIndexTts', () => {
  test('uploads the reference, calls gen_single, and returns the wav bytes', async () => {
    const calls = [];
    const line = 'a'.repeat(500);
    const signal = new AbortController().signal;
    const sse = [
      'event: heartbeat',
      'data: null',
      '',
      'event: complete',
      `data: ${JSON.stringify([{ __type__: 'update', value: { path: 'out.wav' } }])}`,
      '',
    ].join('\n');
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url === uploadUrl) return jsonResponse(['voice/ref.wav']);
      if (url === callUrl) return jsonResponse({ event_id: 'evt-1' });
      if (url === `${callUrl}/evt-1`) return textResponse(sse);
      if (url === `${origin}/gradio_api/file=out.wav`) return new Response(out);
      throw new Error(`unexpected ${url}`);
    };

    const result = await synthesizeIndexTts({
      baseUrl,
      text: `  ${line}  `,
      referenceWav: wav,
      lang: 'FR',
      durationFactor: 0,
      fetchImpl,
      signal,
    });

    assert.deepEqual(result, out);
    assert.equal(calls[0].url, uploadUrl);
    assert.equal(calls[0].init.method, 'POST');
    assert.ok(calls[0].init.body instanceof FormData);
    const file = calls[0].init.body.get('files');
    assert.ok(file instanceof Blob);
    assert.equal(file.name, 'ref.wav');
    assert.equal(file.type, 'audio/wav');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), wav);
    assert.equal(calls.some((call) => call.url === plainUploadUrl), false);

    const post = calls.find((call) => call.url === callUrl);
    const body = postedJson(post);
    assert.equal(body.data.length, 26);
    assert.equal(body.data[0], 'Same as the voice reference');
    assert.deepEqual(body.data, [
      'Same as the voice reference',
      {
        path: 'voice/ref.wav',
        orig_name: 'ref.wav',
        mime_type: 'audio/wav',
        meta: { _type: 'gradio.FileData' },
      },
      line,
      'ZH',
      null,
      0.65,
      0, 0, 0, 0, 0, 0, 0, 0,
      '',
      false,
      120,
      1,
      true,
      0.8,
      30,
      0.8,
      0.0,
      3,
      10.0,
      1500,
    ]);
    assert.equal(calls.at(-1).url, `${origin}/gradio_api/file=out.wav`);
    assert.equal(calls.every((call) => call.init.signal === signal), true);
  });

  test('text over 500 characters throws and does not fetch', async () => {
    let fetched = false;
    await assert.rejects(() => synthesizeIndexTts({
      baseUrl,
      text: 'a'.repeat(501),
      referenceWav: wav,
      fetchImpl: () => {
        fetched = true;
        throw new Error('fetch was called');
      },
    }));
    assert.equal(fetched, false);
  });

  test('falls back to /upload and keeps an absolute file url', async () => {
    const calls = [];
    const sse = [
      'event: complete',
      `data: ${JSON.stringify([{ url: 'https://cdn.example/out.wav' }])}`,
      '',
    ].join('\n');
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url === uploadUrl) return new Response('unavailable', { status: 503 });
      if (url === plainUploadUrl) return jsonResponse({ path: 'from-upload.wav' });
      if (url === callUrl) return jsonResponse({ event_id: 'evt-2' });
      if (url === `${callUrl}/evt-2`) return textResponse(sse);
      if (url === 'https://cdn.example/out.wav') return new Response(out);
      throw new Error(`unexpected ${url}`);
    };

    const result = await synthesizeIndexTts({
      baseUrl: `${origin}///`,
      text: 'hello',
      referenceWav: wav,
      fetchImpl,
    });

    assert.deepEqual(result, out);
    assert.deepEqual(calls.map((call) => call.url), [
      uploadUrl,
      plainUploadUrl,
      callUrl,
      `${callUrl}/evt-2`,
      'https://cdn.example/out.wav',
    ]);
    const body = postedJson(calls[2]);
    assert.equal(body.data[1].path, 'from-upload.wav');
    assert.equal(body.session_hash, undefined);
  });

  test('a 404 on gen_single reuploads once and then downloads a leading-slash url', async () => {
    const calls = [];
    let uploads = 0;
    const okSse = [
      'event: complete',
      `data: ${JSON.stringify([{ url: '/file/out.wav' }])}`,
      '',
    ].join('\n');
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url === uploadUrl) {
        uploads += 1;
        return jsonResponse(uploads === 1 ? 'old.wav' : 'new.wav');
      }
      if (url === callUrl) {
        const body = JSON.parse(init.body);
        if (body.data[1].path === 'old.wav') return new Response('missing', { status: 404 });
        return jsonResponse({ event_id: 'evt-3' });
      }
      if (url === `${callUrl}/evt-3`) return textResponse(okSse);
      if (url === `${origin}/file/out.wav`) return new Response(out);
      throw new Error(`unexpected ${url}`);
    };

    const result = await synthesizeIndexTts({
      baseUrl,
      text: 'hello',
      referenceWav: wav,
      fetchImpl,
    });

    assert.deepEqual(result, out);
    assert.equal(uploads, 2);
    const posts = calls.filter((call) => call.url === callUrl);
    assert.equal(posts.length, 2);
    assert.equal(JSON.parse(posts[0].init.body).data[1].path, 'old.wav');
    assert.equal(JSON.parse(posts[1].init.body).data[1].path, 'new.wav');
    assert.equal(JSON.parse(posts[1].init.body).session_hash, undefined);
    assert.equal(calls.at(-1).url, `${origin}/file/out.wav`);
  });

  test('a non-404 gen_single failure does not reupload', async () => {
    let uploads = 0;
    let posts = 0;
    const fetchImpl = async (url) => {
      if (url === uploadUrl) {
        uploads += 1;
        return jsonResponse(['voice/ref.wav']);
      }
      if (url === callUrl) {
        posts += 1;
        return new Response('busy', { status: 500 });
      }
      throw new Error(`unexpected ${url}`);
    };

    await assert.rejects(() => synthesizeIndexTts({
      baseUrl,
      text: 'hello',
      referenceWav: wav,
      fetchImpl,
    }));
    assert.equal(uploads, 1);
    assert.equal(posts, 1);
  });

  test('an SSE error event fails and does not reupload', async () => {
    let uploads = 0;
    const sse = ['event: error', 'data: "synth failed"', ''].join('\n');
    const fetchImpl = async (url) => {
      if (url === uploadUrl) {
        uploads += 1;
        return jsonResponse(['voice/ref.wav']);
      }
      if (url === callUrl) return jsonResponse({ event_id: 'evt-err' });
      if (url === `${callUrl}/evt-err`) return textResponse(sse);
      throw new Error(`unexpected ${url}`);
    };

    await assert.rejects(() => synthesizeIndexTts({
      baseUrl,
      text: 'hello',
      referenceWav: wav,
      fetchImpl,
    }));
    assert.equal(uploads, 1);
  });

  test('synthesizes with the server default voice when referenceWav is omitted', async () => {
    const calls = [];
    const sse = [
      'event: complete',
      `data: ${JSON.stringify([{ path: 'default-out.wav' }])}`,
      '',
    ].join('\n');
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url === callUrl) return jsonResponse({ event_id: 'evt-default' });
      if (url === `${callUrl}/evt-default`) return textResponse(sse);
      if (url === `${origin}/gradio_api/file=default-out.wav`) return new Response(out);
      throw new Error(`unexpected ${url}`);
    };

    const result = await synthesizeIndexTts({
      baseUrl,
      text: 'default voice test',
      fetchImpl,
    });

    assert.deepEqual(result, out);
    assert.equal(calls.some((call) => call.url === uploadUrl || call.url === plainUploadUrl), false);
    const body = postedJson(calls[0]);
    assert.equal(body.data[1], null);
    assert.equal(body.data[2], 'default voice test');
  });

  test('a second 404 does not upload a third time', async () => {
    let uploads = 0;
    let posts = 0;
    const fetchImpl = async (url) => {
      if (url === uploadUrl) {
        uploads += 1;
        return jsonResponse('voice/ref.wav');
      }
      if (url === callUrl) {
        posts += 1;
        return new Response('404: Not Found', { status: 404 });
      }
      throw new Error(`unexpected ${url}`);
    };

    await assert.rejects(() => synthesizeIndexTts({
      baseUrl,
      text: 'hello',
      referenceWav: wav,
      fetchImpl,
    }));
    assert.equal(uploads, 2);
    assert.equal(posts, 2);
  });
});
