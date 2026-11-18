import { createPlayer } from '/player.js';

const audio = document.querySelector('#player');
const libraryEl = document.querySelector('#library');
const chaptersEl = document.querySelector('#chapters');
const messageEl = document.querySelector('#message');
const nowEl = document.querySelector('#now-playing');
const timeEl = document.querySelector('#time');
const seekEl = document.querySelector('#seek');
const toggleEl = document.querySelector('#toggle');
const downloadEl = document.querySelector('#download');
const generateEl = document.querySelector('#generate');
const voiceStateEl = document.querySelector('#voice-state');
const ttsUrlEl = document.querySelector('#tts-url');
const ttsLangEl = document.querySelector('#tts-lang');
const ttsDurationEl = document.querySelector('#tts-duration');
const ttsPreviewEl = document.querySelector('#tts-preview');
const speedEl = document.querySelector('#speed');
const sleepEl = document.querySelector('#sleep');
const segmentPreviousEl = document.querySelector('#segment-previous');
const segmentNextEl = document.querySelector('#segment-next');

let library = [];
let activeBook = null;
let player = null;
let voiceConfigured = false;
let voiceName = '';
let sleepTimer = null;
let sleepChapterIndex = null;
let skipResume = false;

const statusLabel = { pending: '待生成', ready: '已就绪', failed: '失败' };

function setMessage(text) {
  messageEl.textContent = text || '';
}

function segmentsOf(chapter) {
  return chapter.segments || [];
}

function segmentRollup(chapter) {
  const segments = segmentsOf(chapter);
  if (segments.length > 0 && segments.every((segment) => segment.audio.status === 'ready')) return 'ready';
  if (segments.some((segment) => segment.audio.status === 'failed')) return 'failed';
  return 'pending';
}

function segmentError(chapter) {
  const failed = segmentsOf(chapter).find((segment) => segment.audio.status === 'failed' && segment.audio.error);
  return failed ? failed.audio.error : '';
}

function canPlay(chapter) {
  return segmentsOf(chapter).some((segment) => segment.audio.status === 'ready');
}

function segmentProgress(chapter) {
  const segments = segmentsOf(chapter);
  const ready = segments.filter((segment) => segment.audio?.status === 'ready').length;
  const rollup = segmentRollup(chapter);
  if (ready > 0 && ready < segments.length) return `${ready}/${segments.length} 段已就绪`;
  return `${segments.length} 段 · ${statusLabel[rollup] || rollup}`;
}

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      const comma = value.indexOf(',');
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.onerror = () => reject(reader.error || new Error('无法读取文件'));
    reader.readAsDataURL(file);
  });
}

function fileToText(file) {
  return file.text();
}

async function postImport(body) {
  const response = await fetch('/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);
  activeBook = payload.book;
  bindPlayer(activeBook, -1);
  renderChapters(activeBook);
  await loadLibrary();
  setMessage(`已导入《${activeBook.title}》，共 ${activeBook.chapters.length} 章。`);
}

async function importPdf() {
  const file = document.querySelector('#pdf-file').files[0];
  if (!file) {
    setMessage('请选择一个 PDF 文件。');
    return;
  }
  setMessage('正在导入 PDF…');
  const pdfBase64 = await fileToBase64(file);
  await postImport({ kind: 'pdf', filename: file.name, pdfBase64 });
}

async function importHtml() {
  const file = document.querySelector('#html-file').files[0];
  if (!file) {
    setMessage('请选择一个 HTML 文件。');
    return;
  }
  setMessage('正在导入网页…');
  const html = await fileToText(file);
  await postImport({ kind: 'web', filename: file.name, html });
}

async function importUrl() {
  const url = document.querySelector('#page-url').value.trim();
  if (!url) {
    setMessage('请填写网页 URL。');
    return;
  }
  setMessage('正在抓取网页…');
  await postImport({ kind: 'web', url });
}

function ttsPayload() {
  return {
    baseUrl: ttsUrlEl.value.trim(),
    lang: ttsLangEl.value,
    durationFactor: Number(ttsDurationEl.value),
  };
}

async function saveTts() {
  setMessage('正在保存 Index-TTS 配置…');
  const response = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ttsPayload()),
  });
  const payload = await readJson(response);
  applyTts(payload.tts);
  setMessage('Index-TTS 配置已保存。');
}

async function uploadVoice() {
  const file = document.querySelector('#voice-file').files[0];
  if (!file) {
    setMessage('请先选择一段 3–10 秒的 wav 音色样本。');
    return;
  }
  await saveTts();
  setMessage('正在上传音色样本…');
  const wavBase64 = await fileToBase64(file);
  const response = await fetch('/api/voice', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wavBase64, filename: file.name }),
  });
  const payload = await readJson(response);
  applyTts(payload.tts);
  setMessage(`音色样本已上传：${payload.tts.voiceName || file.name}`);
}

async function testTts() {
  await saveTts();
  setMessage('正在测试 Index-TTS 连接…');
  const response = await fetch('/api/tts/test', { method: 'POST' });
  await readJson(response);
  setMessage('Index-TTS 已连通，服务里有 /gen_single。');
}

async function previewTts() {
  await saveTts();
  setMessage('正在用当前音色试听一句…');
  const response = await fetch('/api/tts/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '这是 Index-TTS 的音色试听。' }),
  });
  if (!response.ok) {
    await readJson(response);
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  ttsPreviewEl.src = url;
  await ttsPreviewEl.play();
  setMessage('正在播放试听。');
}

function renderChapters(book) {
  generateEl.hidden = !book;
  chaptersEl.replaceChildren();
  if (!book) return;
  const heading = document.createElement('p');
  heading.className = 'meta';
  heading.textContent = book.title;
  chaptersEl.append(heading);
  book.chapters.forEach((chapter, index) => {
    const row = document.createElement('article');
    row.className = 'row';
    const title = document.createElement('strong');
    title.textContent = chapter.title;
    const preview = document.createElement('span');
    preview.textContent = chapter.preview || chapter.text;
    const rollup = segmentRollup(chapter);
    const status = document.createElement('span');
    status.className = `status ${rollup}`;
    status.textContent = segmentProgress(chapter);
    const error = segmentError(chapter);
    if (error) status.textContent += `：${error}`;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = '播放';
    play.disabled = !canPlay(chapter);
    play.addEventListener('click', () => selectChapter(book, index));
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = rollup === 'failed' ? '重试' : '生成';
    retry.addEventListener('click', () => generateOne(book.id, chapter.id));
    actions.append(play, retry);
    row.append(title, preview, status, actions);
    chaptersEl.append(row);
  });
}

function renderLibrary() {
  libraryEl.replaceChildren();
  if (library.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'meta';
    empty.textContent = '还没有书籍。';
    libraryEl.append(empty);
    return;
  }
  for (const book of library) {
    const block = document.createElement('article');
    block.className = 'card';
    const title = document.createElement('strong');
    title.textContent = book.title;
    const meta = document.createElement('span');
    meta.textContent = `${book.source.kind === 'pdf' ? 'PDF' : '网页'} · ${book.source.label}`;
    block.append(title, meta);
    book.chapters.forEach((chapter, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'card';
      if (activeBook && activeBook.id === book.id && player && player.index === index) {
        button.classList.add('active');
      }
      const name = document.createElement('strong');
      name.textContent = chapter.title;
      const state = document.createElement('span');
      state.textContent = `${chapter.preview || ''} · ${segmentProgress(chapter)}`;
      button.append(name, state);
      button.addEventListener('click', () => openBookChapter(book, index));
      block.append(button);
    });
    libraryEl.append(block);
  }
}

function applyTts(tts) {
  if (!tts) return;
  if (document.activeElement !== ttsUrlEl) ttsUrlEl.value = tts.baseUrl || '';
  if (document.activeElement !== ttsLangEl) ttsLangEl.value = tts.lang || 'ZH';
  if (document.activeElement !== ttsDurationEl) ttsDurationEl.value = String(tts.durationFactor || 1);
  voiceConfigured = Boolean(tts.voiceConfigured);
  voiceName = tts.voiceName || '';
  renderVoice();
}

function renderVoice() {
  if (voiceConfigured) {
    voiceStateEl.textContent = voiceName ? `已上传音色样本：${voiceName}` : '已上传音色样本';
    return;
  }
  voiceStateEl.textContent = '还没有音色样本。选一个 wav，再点上传。';
}

async function loadLibrary() {
  const response = await fetch('/api/library');
  const payload = await readJson(response);
  library = payload.books;
  applyTts(payload.tts);
  if (activeBook) {
    activeBook = library.find((book) => book.id === activeBook.id) || activeBook;
    renderChapters(activeBook);
  }
  renderLibrary();
}

function bindPlayer(book, index) {
  activeBook = book;
  player = createPlayer({
    audio,
    bookId: book.id,
    chapters: book.chapters,
    onPosition: (position) => showPosition(book, position),
  });
  applySpeed();
  if (index >= 0) player.load(index);
}

function applySpeed() {
  if (!player || !speedEl) return;
  player.setRate(Number(speedEl.value));
}

function resumePlayback() {
  if (!player || skipResume) return;
  const pending = player.resume();
  if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  toggleEl.textContent = '暂停';
}

function togglePlayback() {
  if (!player || player.index < 0) return;
  skipResume = false;
  if (audio.paused) resumePlayback();
  else {
    player.pause();
    toggleEl.textContent = '播放';
  }
}

function stepBy(delta) {
  if (!player) return;
  skipResume = false;
  if (!player.stepSegment(delta)) return;
  resumePlayback();
}

function clearSleepClock() {
  if (sleepTimer === null) return;
  clearTimeout(sleepTimer);
  sleepTimer = null;
}

function resetSleepControl() {
  clearSleepClock();
  sleepChapterIndex = null;
  if (sleepEl) sleepEl.value = '';
}

function armSleep(value) {
  clearSleepClock();
  sleepChapterIndex = null;
  if (value === '15' || value === '30') {
    sleepTimer = setTimeout(() => {
      sleepTimer = null;
      resetSleepControl();
      audio.pause();
      setMessage('睡眠定时已到');
    }, Number(value) * 60 * 1000);
    return;
  }
  if (value === 'chapter') sleepChapterIndex = player ? player.index : -1;
}

function showPosition(book, position) {
  skipResume = false;
  const chapter = book.chapters[position.chapterIndex];
  if (!chapter) return;
  const n = position.segmentIndex + 1;
  const m = position.segmentCount;
  nowEl.textContent = `${book.title} · ${chapter.title} · 第 ${n} / ${m} 段`;
  const segment = segmentsOf(chapter)[position.segmentIndex];
  if (segment) {
    downloadEl.hidden = false;
    downloadEl.href = `/api/books/${book.id}/chapters/${chapter.id}/segments/${segment.id}/audio?download=1`;
  }
  renderLibrary();
  if (sleepChapterIndex !== null && position.chapterIndex > sleepChapterIndex) {
    resetSleepControl();
    audio.pause();
    setMessage('本章已播完');
    skipResume = true;
    return false;
  }
}

function selectChapter(book, index) {
  const current = library.find((item) => item.id === book.id) || book;
  skipResume = false;
  if (!player || !activeBook || activeBook.id !== current.id) bindPlayer(current, index);
  else player.load(index);
  resumePlayback();
}

function openBookChapter(book, index) {
  activeBook = book;
  renderChapters(book);
  if (!canPlay(book.chapters[index])) {
    setMessage('这一章还没有可播放的片段。');
    bindPlayer(book, -1);
    nowEl.textContent = `${book.title} · ${book.chapters[index].title}`;
    return;
  }
  setMessage('');
  selectChapter(book, index);
}

async function generateCurrent() {
  if (!activeBook) return;
  setMessage('正在生成段落片段…');
  const response = await fetch(`/api/books/${activeBook.id}/generate`, { method: 'POST' });
  const payload = await readJson(response);
  activeBook = payload.book;
  renderChapters(activeBook);
  await loadLibrary();
  const failed = activeBook.chapters.reduce((count, chapter) => (
    count + segmentsOf(chapter).filter((segment) => segment.audio.status === 'failed').length
  ), 0);
  setMessage(failed ? `${failed} 段生成失败，可以重试。` : '段落片段已写入资料库。');
}

async function generateOne(bookId, chapterId) {
  setMessage('正在生成这一章的段落…');
  const response = await fetch(`/api/books/${bookId}/chapters/${chapterId}/generate`, { method: 'POST' });
  const payload = await readJson(response);
  activeBook = payload.book;
  renderChapters(activeBook);
  await loadLibrary();
  setMessage('这一章已处理。');
}

function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(whole / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return `${minutes}:${rest}`;
}

function renderProgress() {
  if (!player) return;
  const { currentTime, duration } = player.progress();
  timeEl.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
  if (!seekEl.matches(':active')) {
    seekEl.value = duration > 0 ? String(Math.round((currentTime / duration) * 1000)) : '0';
  }
}

document.querySelector('#import-pdf').addEventListener('click', () => {
  importPdf().catch((error) => setMessage(error.message));
});
document.querySelector('#import-html').addEventListener('click', () => {
  importHtml().catch((error) => setMessage(error.message));
});
document.querySelector('#import-url').addEventListener('click', () => {
  importUrl().catch((error) => setMessage(error.message));
});
document.querySelector('#save-tts').addEventListener('click', () => {
  saveTts().catch((error) => setMessage(error.message));
});
document.querySelector('#upload-voice').addEventListener('click', () => {
  uploadVoice().catch((error) => setMessage(error.message));
});
document.querySelector('#test-tts').addEventListener('click', () => {
  testTts().catch((error) => setMessage(error.message));
});
document.querySelector('#preview-tts').addEventListener('click', () => {
  previewTts().catch((error) => setMessage(error.message));
});
document.querySelector('#refresh').addEventListener('click', () => {
  loadLibrary().catch((error) => setMessage(error.message));
});
generateEl.addEventListener('click', () => {
  generateCurrent().catch((error) => setMessage(error.message));
});
document.querySelector('#previous').addEventListener('click', () => {
  if (!player) return;
  player.previous();
});
document.querySelector('#next').addEventListener('click', () => {
  if (!player) return;
  player.next();
});
if (segmentPreviousEl) segmentPreviousEl.addEventListener('click', () => stepBy(-1));
if (segmentNextEl) segmentNextEl.addEventListener('click', () => stepBy(1));
if (speedEl) speedEl.addEventListener('change', applySpeed);
if (sleepEl) sleepEl.addEventListener('change', () => armSleep(sleepEl.value));
toggleEl.addEventListener('click', togglePlayback);
document.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  if (event.key !== ' ' && event.code !== 'Space') return;
  const tag = event.target && event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
  event.preventDefault();
  togglePlayback();
});
audio.addEventListener('play', () => {
  toggleEl.textContent = '暂停';
});
audio.addEventListener('pause', () => {
  toggleEl.textContent = '播放';
});
audio.addEventListener('timeupdate', renderProgress);
audio.addEventListener('durationchange', renderProgress);
audio.addEventListener('loadedmetadata', renderProgress);
seekEl.addEventListener('input', () => {
  if (!player) return;
  const { duration } = player.progress();
  if (duration > 0) audio.currentTime = (Number(seekEl.value) / 1000) * duration;
});

loadLibrary().catch((error) => setMessage(error.message));
