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

let library = [];
let activeBook = null;
let player = null;

const statusLabel = { pending: '待生成', ready: '已就绪', failed: '失败' };

function setMessage(text) {
  messageEl.textContent = text || '';
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
    const status = document.createElement('span');
    status.className = `status ${chapter.audio.status}`;
    status.textContent = statusLabel[chapter.audio.status] || chapter.audio.status;
    if (chapter.audio.error) status.textContent += `：${chapter.audio.error}`;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = '播放';
    play.disabled = chapter.audio.status !== 'ready';
    play.addEventListener('click', () => selectChapter(book, index));
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = chapter.audio.status === 'failed' ? '重试' : '生成';
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
      state.textContent = `${chapter.preview || ''} · ${statusLabel[chapter.audio.status] || chapter.audio.status}`;
      button.append(name, state);
      button.addEventListener('click', () => openBookChapter(book, index));
      block.append(button);
    });
    libraryEl.append(block);
  }
}

async function loadLibrary() {
  const response = await fetch('/api/library');
  const payload = await readJson(response);
  library = payload.books;
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
    onChapter: (nextIndex) => showChapter(book, nextIndex),
  });
  if (index >= 0) player.load(index);
}

function showChapter(book, index) {
  const chapter = book.chapters[index];
  if (!chapter) return;
  nowEl.textContent = `${book.title} · ${chapter.title}`;
  downloadEl.hidden = false;
  downloadEl.href = `/api/books/${book.id}/chapters/${chapter.id}/audio?download=1`;
  renderLibrary();
}

function selectChapter(book, index) {
  const current = library.find((item) => item.id === book.id) || book;
  if (!player || !activeBook || activeBook.id !== current.id) bindPlayer(current, index);
  else player.load(index);
  const pending = player.resume();
  if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  toggleEl.textContent = '暂停';
}

function openBookChapter(book, index) {
  activeBook = book;
  renderChapters(book);
  if (book.chapters[index].audio.status !== 'ready') {
    setMessage('这一章还没有可播放的音频。');
    bindPlayer(book, -1);
    nowEl.textContent = `${book.title} · ${book.chapters[index].title}`;
    return;
  }
  setMessage('');
  selectChapter(book, index);
}

async function generateCurrent() {
  if (!activeBook) return;
  setMessage('正在生成章节音频…');
  const response = await fetch(`/api/books/${activeBook.id}/generate`, { method: 'POST' });
  const payload = await readJson(response);
  activeBook = payload.book;
  renderChapters(activeBook);
  await loadLibrary();
  const failed = activeBook.chapters.filter((chapter) => chapter.audio.status === 'failed').length;
  setMessage(failed ? `${failed} 章生成失败，可以重试。` : '章节音频已写入资料库。');
}

async function generateOne(bookId, chapterId) {
  setMessage('正在生成这一章…');
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
toggleEl.addEventListener('click', () => {
  if (!player || player.index < 0) return;
  if (audio.paused) {
    const pending = player.resume();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    toggleEl.textContent = '暂停';
  } else {
    player.pause();
    toggleEl.textContent = '播放';
  }
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
