const LANGS = ['ZH', 'EN', 'JA', 'AR', 'ES'];

export function buildGenSingleData({
  promptFile,
  text,
  lang = 'ZH',
  durationFactor = 1,
  emotionFile = null,
} = {}) {
  const factor = Number(durationFactor);
  return [
    emotionFile ? 'Use emotion reference audio' : 'Same as the voice reference',
    promptFile,
    String(text || ''),
    LANGS.includes(lang) ? lang : 'ZH',
    emotionFile,
    emotionFile ? 0.8 : 0.65,
    0, 0, 0, 0, 0, 0, 0, 0,
    '',
    false,
    120,
    Number.isFinite(factor) && factor > 0 ? factor : 1,
    true,
    0.8,
    30,
    0.8,
    0.0,
    3,
    10.0,
    1500,
  ];
}

function originOf(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/gradio_api\/?$/i, '');
}

export async function testIndexTts(baseUrl, fetchImpl = globalThis.fetch) {
  const origin = originOf(baseUrl);
  if (!origin) {
    const error = new Error('先填写 Index-TTS 地址');
    error.status = 400;
    throw error;
  }
  const response = await fetchImpl(`${origin}/gradio_api/info`);
  if (!response.ok) {
    const error = new Error(`Index-TTS 连接失败：${response.status}`);
    error.status = 502;
    throw error;
  }
  const json = await response.json();
  if (!json?.named_endpoints?.['/gen_single']) {
    const error = new Error('服务在线，但没有 /gen_single');
    error.status = 502;
    throw error;
  }
  return { ok: true };
}

function pathFromUpload(uploaded) {
  if (typeof uploaded === 'string') return uploaded;
  const item = Array.isArray(uploaded) ? uploaded[0] : uploaded;
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && typeof item.path === 'string') return item.path;
  return '';
}

function fileData(uploaded) {
  const path = pathFromUpload(uploaded);
  if (!path) throw new Error('reference upload returned no path');
  return {
    path,
    orig_name: 'ref.wav',
    mime_type: 'audio/wav',
    meta: { _type: 'gradio.FileData' },
  };
}

async function errorText(response) {
  const detail = await response.text();
  return `${response.status} ${detail}`.trim();
}

function isNotFound(error) {
  if (error?.status === 404) return true;
  return /\b404\b|file.*(?:not found|does not exist)/i.test(error?.message || '');
}

async function uploadReference(origin, referenceWav, fetchImpl, signal) {
  const urls = [`${origin}/gradio_api/upload`, `${origin}/upload`];
  let last = 'reference upload failed';
  for (const url of urls) {
    const form = new FormData();
    form.append('files', new Blob([referenceWav], { type: 'audio/wav' }), 'ref.wav');
    const response = await fetchImpl(url, { method: 'POST', body: form, signal });
    if (!response.ok) {
      last = `reference upload failed: ${await errorText(response)}`;
      continue;
    }
    return fileData(await response.json());
  }
  throw new Error(last);
}

function parseSseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of String(block).split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  return { event, data: data.join('\n') };
}

function unwrapFile(data) {
  let cur = data;
  for (let i = 0; i < 6; i += 1) {
    if (!cur) break;
    if (Array.isArray(cur) && cur.length) {
      cur = cur[0];
      continue;
    }
    if (typeof cur === 'object' && (cur.url || cur.path)) return cur;
    if (typeof cur === 'object' && cur.__type__ === 'update' && 'value' in cur) {
      cur = cur.value;
      continue;
    }
    break;
  }
  return cur;
}

function resolveGradioFileUrl(origin, file) {
  if (!file) return '';
  if (typeof file === 'string') {
    if (/^https?:/i.test(file)) return file;
    if (file.startsWith('/')) return origin + file;
    return `${origin}/gradio_api/file=${file}`;
  }
  if (file.url) {
    if (/^https?:/i.test(file.url)) return file.url;
    return origin + (file.url.startsWith('/') ? file.url : `/${file.url}`);
  }
  if (file.path) return `${origin}/gradio_api/file=${file.path}`;
  return '';
}

async function readGenSingleResult(origin, eventId, fetchImpl, signal) {
  const response = await fetchImpl(`${origin}/gradio_api/call/gen_single/${eventId}`, {
    method: 'GET',
    signal,
  });
  if (!response.ok) {
    const error = new Error(`gen_single failed: ${await errorText(response)}`);
    error.status = response.status;
    throw error;
  }
  const blocks = (await response.text()).split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const event = parseSseBlock(block);
    if (!event.data) continue;
    if (event.event === 'error') {
      let detail = event.data;
      try {
        detail = JSON.parse(event.data);
      } catch {
        detail = event.data;
      }
      const message = typeof detail === 'string' ? detail : JSON.stringify(detail);
      const error = new Error(`gen_single failed: ${message}`);
      if (isNotFound({ message })) error.status = 404;
      throw error;
    }
    if (event.event !== 'complete') continue;
    try {
      return JSON.parse(event.data);
    } catch {
      throw new Error('gen_single complete event was not JSON');
    }
  }
  throw new Error('gen_single returned no complete event');
}

async function callGenSingle(origin, promptFile, text, lang, durationFactor, fetchImpl, signal) {
  const response = await fetchImpl(`${origin}/gradio_api/call/gen_single`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Gradio 5.45 stores a custom session_hash on another queue, so the
    // event_id GET returns 404. The event_id alone is the queue key.
    body: JSON.stringify({
      data: buildGenSingleData({ promptFile, text, lang, durationFactor }),
    }),
    signal,
  });
  if (!response.ok) {
    const error = new Error(`gen_single failed: ${await errorText(response)}`);
    error.status = response.status;
    throw error;
  }
  const queued = await response.json();
  const eventId = queued?.event_id || queued?.eventId;
  if (!eventId) throw new Error('gen_single returned no event_id');
  return readGenSingleResult(origin, eventId, fetchImpl, signal);
}

export async function synthesizeIndexTts({
  baseUrl,
  text,
  referenceWav = null,
  lang,
  durationFactor,
  fetchImpl = fetch,
  signal,
} = {}) {
  const origin = originOf(baseUrl);
  if (!origin) throw new Error('baseUrl is required');
  if (text == null || String(text).trim() === '') throw new Error('text is required');
  const line = String(text).trim();
  if (line.length > 500) throw new Error('text exceeds 500 characters');

  let promptFile = referenceWav != null
    ? await uploadReference(origin, referenceWav, fetchImpl, signal)
    : null;
  let result;
  try {
    result = await callGenSingle(origin, promptFile, line, lang, durationFactor, fetchImpl, signal);
  } catch (error) {
    if (referenceWav == null || error?.name === 'AbortError' || !isNotFound(error)) throw error;
    promptFile = await uploadReference(origin, referenceWav, fetchImpl, signal);
    result = await callGenSingle(origin, promptFile, line, lang, durationFactor, fetchImpl, signal);
  }

  const fileUrl = resolveGradioFileUrl(origin, unwrapFile(result));
  if (!fileUrl) throw new Error('gen_single returned no audio url');
  const audio = await fetchImpl(fileUrl, { method: 'GET', signal });
  if (!audio.ok) throw new Error(`audio download failed: ${await errorText(audio)}`);
  return Buffer.from(await audio.arrayBuffer());
}
