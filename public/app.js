import { createPlayer } from '/player.js';
import { confirmLibraryAudioClear } from '/library-audio.js';

const audio = document.querySelector('#player');
const libraryEl = document.querySelector('#library');
const chaptersEl = document.querySelector('#chapters');
const readerEl = document.querySelector('#reader');
const messageEl = document.querySelector('#message');
const nowEl = document.querySelector('#now-playing');
const timeEl = document.querySelector('#time');
const seekEl = document.querySelector('#seek');
const toggleEl = document.querySelector('#toggle');
const downloadEl = document.querySelector('#download');
const generateEl = document.querySelector('#generate');
const clearLibraryAudioEl = document.querySelector('#clear-library-audio');
const voiceStateEl = document.querySelector('#voice-state');
const ttsUrlEl = document.querySelector('#tts-url');
const ttsLangEl = document.querySelector('#tts-lang');
const ttsDurationEl = document.querySelector('#tts-duration');
const ttsPreviewEl = document.querySelector('#tts-preview');
const speedEl = document.querySelector('#speed');
const sleepEl = document.querySelector('#sleep');
const segmentPreviousEl = document.querySelector('#segment-previous');
const segmentNextEl = document.querySelector('#segment-next');
const headerVoicePillEl = document.querySelector('#header-voice-pill');
const headerVoiceTextEl = document.querySelector('#header-voice-text');
const ttsBadgeEl = document.querySelector('#tts-badge');
const chapterFiltersEl = document.querySelector('#chapter-filters');
const stageModeTabsEl = document.querySelector('#stage-mode-tabs');
const visualizerEl = document.querySelector('#player-visualizer');
const layoutEl = document.querySelector('main.layout');
const subtitleBarEl = document.querySelector('#subtitle-bar');
const subtitleMetaEl = document.querySelector('#subtitle-meta');
const subtitleTextEl = document.querySelector('#subtitle-text');
const subtitleLocateEl = document.querySelector('#subtitle-locate');
const subtitleProgressFillEl = document.querySelector('#subtitle-progress-fill');
const subtitleToggleEl = document.querySelector('#subtitle-toggle');
const autogenToggleEl = document.querySelector('#autogen-toggle');

let library = [];
let activeBook = null;
let selectedChapterIndex = 0;
let chapterFilter = 'all';
let stageMode = 'chapters';
let subtitlesEnabled = true;
let autoFollowEnabled = true;
let autoGenerateEnabled = true;
try {
  subtitlesEnabled = localStorage.getItem('audiobook.subtitles') !== '0';
  autoFollowEnabled = localStorage.getItem('audiobook.autofollow') !== '0';
  autoGenerateEnabled = localStorage.getItem('audiobook.autogen') !== '0';
} catch {
  // Ignore storage restrictions
}

const expandedChapters = new Set();
let player = null;
let playerBookId = '';
let clearingLibraryAudio = false;
let voiceConfigured = false;
let voiceName = '';
let sleepTimer = null;
let sleepChapterIndex = null;
let skipResume = false;
let generation = null;
let readerKey = '';
let progressRaf = null;
let lastHighlightKey = '';
let lastSubtitleKey = '';
let lastTimeText = '';
let lastSeekValue = '';
let lastRenderedChapterKey = '';
let waitingMessageShown = false;
let restoringPosition = false;
let lastLocalSaveAt = 0;
let lastServerSaveAt = 0;

const PREGEN_TRIGGER = 4;
const PREGEN_TARGET = 6;

const PROGRESS_KEY = 'audiobook.progress.v1';
let progressStore = loadLocalProgress();

const statusLabel = { pending: '待生成', ready: '已就绪', failed: '失败' };
const SENTENCE_CLOSERS = '”’」』"\')）]】';
const SENTENCE_ENDS = '。！？!?；;\n';

function loadLocalProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return { books: {}, lastBookId: '' };
    const parsed = JSON.parse(raw);
    const books = parsed && typeof parsed.books === 'object' && !Array.isArray(parsed.books) && parsed.books !== null
      ? parsed.books
      : {};
    const lastBookId = typeof parsed?.lastBookId === 'string' ? parsed.lastBookId : '';
    return { books, lastBookId };
  } catch {
    return { books: {}, lastBookId: '' };
  }
}

function persistLocalProgress() {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progressStore));
  } catch {
    // Ignore storage quota / privacy errors
  }
}

function mergeChapterMaps(localMap, serverMap) {
  const merged = {};
  const allIds = new Set([
    ...Object.keys(localMap || {}),
    ...Object.keys(serverMap || {}),
  ]);
  for (const chId of allIds) {
    const l = localMap?.[chId];
    const s = serverMap?.[chId];
    if (l && s) {
      merged[chId] = (Number(s.updatedAt) || 0) > (Number(l.updatedAt) || 0) ? { ...s } : { ...l };
    } else if (s) {
      merged[chId] = { ...s };
    } else if (l) {
      merged[chId] = { ...l };
    }
  }
  return merged;
}

function mergeProgressStore(serverProgress) {
  if (!serverProgress || typeof serverProgress !== 'object') return;
  const serverBooks = serverProgress.books && typeof serverProgress.books === 'object'
    ? serverProgress.books
    : {};
  const allBookIds = new Set([
    ...Object.keys(progressStore.books || {}),
    ...Object.keys(serverBooks),
  ]);
  const nextBooks = {};
  for (const bookId of allBookIds) {
    const localBook = progressStore.books?.[bookId];
    const serverBook = serverBooks[bookId];
    const mergedChapters = mergeChapterMaps(localBook?.chapters, serverBook?.chapters);
    if (localBook && serverBook) {
      const winner = (Number(serverBook.updatedAt) || 0) > (Number(localBook.updatedAt) || 0)
        ? serverBook
        : localBook;
      nextBooks[bookId] = { ...winner, chapters: mergedChapters };
    } else if (serverBook) {
      nextBooks[bookId] = { ...serverBook, chapters: mergedChapters };
    } else if (localBook) {
      nextBooks[bookId] = { ...localBook, chapters: mergedChapters };
    }
  }
  const localLast = progressStore.lastBookId;
  const serverLast = typeof serverProgress.lastBookId === 'string' ? serverProgress.lastBookId : '';
  let nextLast = localLast || serverLast;
  if (localLast && serverLast) {
    const localTs = Number(nextBooks[localLast]?.updatedAt) || 0;
    const serverTs = Number(nextBooks[serverLast]?.updatedAt) || 0;
    nextLast = serverTs > localTs ? serverLast : localLast;
  }
  progressStore = { books: nextBooks, lastBookId: nextLast };
  persistLocalProgress();
}

function resolveSavedPosition(book, entry) {
  if (!book || !entry || !Array.isArray(book.chapters) || book.chapters.length === 0) return null;
  let chapterIndex = -1;
  if (entry.chapterId) {
    chapterIndex = book.chapters.findIndex((c) => c.id === entry.chapterId);
  }
  if (chapterIndex < 0 && Number.isInteger(entry.chapterIndex) && entry.chapterIndex >= 0 && entry.chapterIndex < book.chapters.length) {
    chapterIndex = entry.chapterIndex;
  }
  if (chapterIndex < 0) return null;
  const chapter = book.chapters[chapterIndex];
  if (!canPlay(chapter)) return null;

  const segments = segmentsOf(chapter);
  let segmentIndex = -1;
  if (entry.segmentId) {
    segmentIndex = segments.findIndex((s) => s.id === entry.segmentId);
  }
  if (segmentIndex < 0 && Number.isInteger(entry.segmentIndex) && entry.segmentIndex >= 0 && entry.segmentIndex < segments.length) {
    segmentIndex = entry.segmentIndex;
  }
  if (segmentIndex >= 0 && segments[segmentIndex]?.audio?.status === 'ready') {
    const currentTime = Math.max(0, Number(entry.currentTime) || 0);
    return { chapterIndex, segmentIndex, currentTime };
  }

  for (let i = Math.min(Math.max(segmentIndex, 0), segments.length - 1); i >= 0; i -= 1) {
    if (segments[i]?.audio?.status === 'ready') {
      return { chapterIndex, segmentIndex: i, currentTime: 0 };
    }
  }
  return { chapterIndex, segmentIndex: firstReadySegmentIndex(chapter), currentTime: 0 };
}

function getBookSavedPosition(book) {
  if (!book) return null;
  return resolveSavedPosition(book, progressStore.books?.[book.id]);
}

function getChapterSavedPosition(book, chapterIndex) {
  if (!book) return null;
  const chapter = book.chapters?.[chapterIndex];
  if (!chapter) return null;
  const bookEntry = progressStore.books?.[book.id];
  const chapterEntry = bookEntry?.chapters?.[chapter.id]
    || (bookEntry?.chapterId === chapter.id ? bookEntry : null);
  const resolved = resolveSavedPosition(book, chapterEntry);
  if (!resolved || resolved.chapterIndex !== chapterIndex) return null;
  return resolved;
}

function saveCurrentProgress({ syncServer = false, beacon = false, currentTimeOverride = null } = {}) {
  const book = resolveBookById(playerBookId);
  if (!player || !book || player.index < 0 || player.segmentIndex < 0) return;
  const chapter = book.chapters?.[player.index];
  const segment = segmentsOf(chapter)[player.segmentIndex];
  if (!chapter || !segment || segment.audio?.status !== 'ready') return;

  const rawTime = currentTimeOverride !== null ? currentTimeOverride : player.progress().currentTime;
  const currentTime = Math.round(Math.max(0, Number.isFinite(rawTime) ? rawTime : 0) * 100) / 100;
  const now = Date.now();

  const entry = {
    chapterId: chapter.id,
    chapterIndex: player.index,
    segmentId: segment.id,
    segmentIndex: player.segmentIndex,
    currentTime,
    updatedAt: now,
  };

  const prevBook = progressStore.books?.[book.id];
  const prevChapters = prevBook?.chapters && typeof prevBook.chapters === 'object' ? { ...prevBook.chapters } : {};
  prevChapters[chapter.id] = { ...entry };
  progressStore.books[book.id] = { ...entry, chapters: prevChapters };
  progressStore.lastBookId = book.id;
  lastLocalSaveAt = now;
  persistLocalProgress();

  const shouldPost = beacon || syncServer || now - lastServerSaveAt >= 5000;
  if (!shouldPost) return;
  lastServerSaveAt = now;

  const endpoint = `/api/books/${book.id}/progress`;
  const payload = JSON.stringify(entry);
  if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const sent = navigator.sendBeacon(endpoint, new Blob([payload], { type: 'application/json' }));
    if (sent) return;
  }
  fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
    keepalive: Boolean(beacon),
  }).catch(() => {});
}

function setMessage(text) {
  messageEl.textContent = text || '';
}

function resolveBookById(bookId) {
  if (activeBook && activeBook.id === bookId) return activeBook;
  return library.find((item) => item.id === bookId) || activeBook;
}

function segmentsOf(chapter) {
  return chapter?.segments || [];
}

function segmentFullText(segment) {
  return String(segment?.fullText || segment?.text || '').trim();
}

function splitSentences(text) {
  const source = String(text || '').trim();
  if (!source) return [];
  const parts = [];
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (!SENTENCE_ENDS.includes(source[i])) continue;
    let end = i + 1;
    while (end < source.length && SENTENCE_CLOSERS.includes(source[end])) {
      end += 1;
    }
    const slice = source.slice(start, end).trim();
    if (slice) parts.push(slice);
    start = end;
    i = end - 1;
  }
  const tail = source.slice(start).trim();
  if (tail) parts.push(tail);
  return parts.length > 0 ? parts : [source];
}

function sentenceWeight(sentence) {
  const s = String(sentence || '');
  let weight = Math.max(1, s.replace(/\s+/g, '').length);
  for (const ch of s) {
    if ('，,、：:'.includes(ch)) weight += 4;
    else if ('。！？!?；;'.includes(ch)) weight += 6;
  }
  return weight;
}

function activeSentenceIndex(sentences, currentTime, duration) {
  if (!Array.isArray(sentences) || sentences.length <= 1 || !(duration > 0)) return 0;
  const ratio = Math.max(0, Math.min(0.9999, currentTime / duration));
  const weights = sentences.map(sentenceWeight);
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let acc = 0;
  for (let i = 0; i < weights.length; i += 1) {
    acc += weights[i] / total;
    if (ratio < acc) return i;
  }
  return sentences.length - 1;
}

function groupChapterSegments(chapter) {
  const segments = segmentsOf(chapter);
  const rawText = String(chapter.text || '');
  const groups = [];
  let currentGroup = null;
  let cursor = 0;
  let currentChars = 0;

  segments.forEach((segment, segmentIndex) => {
    const full = segmentFullText(segment);
    const sentences = splitSentences(full);
    let hasLineBreakBefore = false;

    if (rawText) {
      const probe = full.replace(/\s+/g, ' ').trim().slice(0, 14);
      let foundAt = probe ? rawText.indexOf(probe, cursor) : -1;
      if (foundAt < 0 && probe.length > 6) {
        foundAt = rawText.indexOf(probe.slice(0, 6), cursor);
      }
      if (foundAt >= cursor) {
        const gap = rawText.slice(cursor, foundAt);
        if (segmentIndex > 0 && gap.includes('\n')) hasLineBreakBefore = true;
        cursor = Math.min(rawText.length, foundAt + full.length);
      }
    }

    const prevItem = currentGroup?.segments[currentGroup.segments.length - 1];
    const prevEndsSentence = prevItem ? /[。！？.!?…]$/.test(prevItem.full) : false;
    const shouldBreak = !currentGroup
      || hasLineBreakBefore
      || (currentChars >= 220 && prevEndsSentence);

    if (shouldBreak) {
      currentGroup = { segments: [] };
      groups.push(currentGroup);
      currentChars = 0;
    }

    currentGroup.segments.push({ segmentIndex, segment, full, sentences });
    currentChars += full.length;
  });

  return groups;
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

function firstReadySegmentIndex(chapter) {
  const idx = segmentsOf(chapter).findIndex((segment) => segment.audio?.status === 'ready');
  return idx >= 0 ? idx : 0;
}

function segmentCounts(chapter) {
  const segments = segmentsOf(chapter);
  const ready = segments.filter((segment) => segment.audio?.status === 'ready').length;
  return { ready, total: segments.length };
}

function bookSegmentCounts(book) {
  let ready = 0;
  let total = 0;
  for (const chapter of book.chapters || []) {
    const counts = segmentCounts(chapter);
    ready += counts.ready;
    total += counts.total;
  }
  return { ready, total };
}

function segmentProgress(chapter) {
  const { ready, total } = segmentCounts(chapter);
  const rollup = segmentRollup(chapter);
  if (ready > 0 && ready < total) return `${ready}/${total} 段已就绪`;
  return `${total} 段 · ${statusLabel[rollup] || rollup}`;
}

function compactTocBadge(chapter, isPlayingThis) {
  if (isPlayingThis) return { text: '播放中', cls: 'ready' };
  const { ready, total } = segmentCounts(chapter);
  const rollup = segmentRollup(chapter);
  if (rollup === 'ready') return { text: `${total}段 · 就绪`, cls: 'ready' };
  if (rollup === 'failed') return { text: '失败', cls: 'failed' };
  if (ready > 0) return { text: `${ready}/${total}`, cls: 'partial' };
  return { text: `${total}段`, cls: '' };
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

function switchMobileView(view) {
  if (!layoutEl) return;
  layoutEl.dataset.activeView = view;
  document.querySelectorAll('.mobile-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mobileView === view);
  });
}

function updateSubtitleToggleUI() {
  if (!subtitleToggleEl) return;
  subtitleToggleEl.classList.toggle('is-active', subtitlesEnabled);
  subtitleToggleEl.setAttribute('aria-pressed', subtitlesEnabled ? 'true' : 'false');
}

function updateAutogenToggleUI() {
  if (!autogenToggleEl) return;
  const isAutoRunning = Boolean(generation && generation.mode === 'auto');
  autogenToggleEl.classList.toggle('is-active', autoGenerateEnabled);
  autogenToggleEl.classList.toggle('is-generating', isAutoRunning);
  autogenToggleEl.setAttribute('aria-pressed', autoGenerateEnabled ? 'true' : 'false');
  autogenToggleEl.textContent = isAutoRunning ? '预生成中' : '边听边生成';
}

function readyAheadCount(chapter, fromIndex) {
  const segments = segmentsOf(chapter);
  let count = 0;
  for (let i = Math.max(0, fromIndex); i < segments.length && count < PREGEN_TARGET; i += 1) {
    if (segments[i]?.audio?.status === 'ready') count += 1;
    else break;
  }
  return count;
}

function hasPendingWithinTarget(chapter, fromIndex) {
  const segments = segmentsOf(chapter);
  const end = Math.min(segments.length, Math.max(0, fromIndex) + PREGEN_TARGET);
  for (let i = Math.max(0, fromIndex); i < end; i += 1) {
    const st = segments[i]?.audio?.status;
    if (st === 'pending') return true;
    if (st === 'failed') return false;
  }
  return false;
}

function maybeAutoPregenerate() {
  if (!autoGenerateEnabled || !player || player.index < 0 || !activeBook || playerBookId !== activeBook.id) return;
  if (!player.playing && !player.waiting) return;
  if (generation) return;
  const chapter = activeBook.chapters?.[player.index];
  if (!chapter) return;
  const fromIndex = Math.max(0, player.segmentIndex);
  if (readyAheadCount(chapter, fromIndex) >= PREGEN_TRIGGER) return;
  if (!hasPendingWithinTarget(chapter, fromIndex)) return;
  runGeneration(activeBook.id, chapter.id, { mode: 'auto', startIndex: fromIndex }).catch(() => {});
}

function setStageMode(mode, { focusHighlight = false } = {}) {
  stageMode = mode === 'reader' ? 'reader' : 'chapters';
  if (stageModeTabsEl) {
    stageModeTabsEl.querySelectorAll('.mode-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.stageMode === stageMode);
    });
  }
  const showReader = stageMode === 'reader' && Boolean(activeBook);
  if (chapterFiltersEl) chapterFiltersEl.hidden = !activeBook || showReader;
  chaptersEl.hidden = showReader;
  if (readerEl) readerEl.hidden = !showReader;
  if (showReader) {
    renderReader(activeBook, selectedChapterIndex, true);
    if (focusHighlight) syncReadAlongHighlight(true);
  } else if (activeBook) {
    renderChapters(activeBook);
  }
}

async function postImport(body) {
  const response = await fetch('/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);
  activeBook = payload.book;
  selectedChapterIndex = 0;
  readerKey = '';
  bindPlayer(activeBook, -1);
  setStageMode('chapters');
  await loadLibrary();
  switchMobileView('stage');
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
  if (stageModeTabsEl) stageModeTabsEl.hidden = !book;
  if (chapterFiltersEl) chapterFiltersEl.hidden = !book || stageMode === 'reader';
  const generatingBook = generation && book && generation.bookId === book.id;
  generateEl.textContent = generatingBook ? '暂停生成' : '生成段落音频';
  chaptersEl.replaceChildren();

  if (!book) {
    const empty = document.createElement('div');
    empty.className = 'stage-empty';
    const title = document.createElement('h3');
    title.textContent = '从右侧导入书籍或网页开始朗读';
    const desc = document.createElement('p');
    desc.textContent = '支持导入本地 PDF 电子书、网页 HTML 文件或文章 URL。系统会自动按章节切分短段落并使用 Index-TTS 音色逐段合成。';
    empty.append(title, desc);
    chaptersEl.append(empty);
    return;
  }

  const { ready: bookReady, total: bookTotal } = bookSegmentCounts(book);
  const bookPct = bookTotal > 0 ? Math.round((bookReady / bookTotal) * 100) : 0;

  const hero = document.createElement('div');
  hero.className = 'book-hero';

  const heroTop = document.createElement('div');
  heroTop.className = 'book-hero-top';

  const titleWrap = document.createElement('div');
  const heading = document.createElement('p');
  heading.className = 'meta book-hero-title';
  heading.textContent = book.title;
  titleWrap.append(heading);

  const stats = document.createElement('div');
  stats.className = 'book-hero-stats';

  const sourceChip = document.createElement('span');
  sourceChip.className = 'stat-chip';
  sourceChip.textContent = `${book.source.kind === 'pdf' ? 'PDF 文档' : '网页文章'} · ${book.source.label}`;

  const countChip = document.createElement('span');
  countChip.className = 'stat-chip';
  countChip.textContent = `共 ${book.chapters.length} 章 · ${bookReady} / ${bookTotal} 段已就绪 (${bookPct}%)`;

  stats.append(sourceChip, countChip);
  heroTop.append(titleWrap, stats);

  const bookSaved = getBookSavedPosition(book);
  if (bookSaved) {
    const savedCh = book.chapters[bookSaved.chapterIndex];
    const totalSegs = segmentsOf(savedCh).length;
    const isAlreadyPlayingSaved = Boolean(
      player
      && playerBookId === book.id
      && player.index === bookSaved.chapterIndex
      && player.segmentIndex === bookSaved.segmentIndex
      && player.playing,
    );
    if (!isAlreadyPlayingSaved) {
      const resumeBtn = document.createElement('button');
      resumeBtn.type = 'button';
      resumeBtn.className = 'primary sm-button book-resume-btn';
      resumeBtn.textContent = `继续上次播放 · ${savedCh?.title || ''} 第 ${bookSaved.segmentIndex + 1}/${totalSegs} 段`;
      resumeBtn.addEventListener('click', () => {
        restoreBookPosition(book, { autoplay: true });
      });
      heroTop.append(resumeBtn);
    }
  }

  const heroBar = document.createElement('div');
  heroBar.className = 'mini-progress-track';
  const heroFill = document.createElement('div');
  heroFill.className = 'mini-progress-fill';
  heroFill.style.width = `${bookPct}%`;
  heroBar.append(heroFill);

  hero.append(heroTop, heroBar);
  chaptersEl.append(hero);

  book.chapters.forEach((chapter, index) => {
    const rollup = segmentRollup(chapter);
    const { ready, total } = segmentCounts(chapter);
    if (chapterFilter === 'ready' && !canPlay(chapter)) return;
    if (chapterFilter === 'pending' && rollup === 'ready') return;

    const isPlayingChapter = player && playerBookId === book.id && player.index === index;
    const isSelectedChapter = selectedChapterIndex === index;

    const row = document.createElement('article');
    row.className = 'row';
    row.dataset.chapterIndex = String(index);
    row.dataset.chapterId = chapter.id;
    if (isPlayingChapter) row.classList.add('is-playing');
    if (isSelectedChapter) row.classList.add('is-selected');

    const rowHead = document.createElement('div');
    rowHead.className = 'row-head';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'row-title-group';

    const numBadge = document.createElement('span');
    numBadge.className = 'chapter-num-badge';
    numBadge.textContent = isPlayingChapter ? '播放中' : `#${String(index + 1).padStart(2, '0')}`;

    const title = document.createElement('strong');
    title.textContent = chapter.title;
    titleGroup.append(numBadge, title);

    const status = document.createElement('span');
    status.className = `status ${rollup}`;
    status.textContent = segmentProgress(chapter);
    const error = segmentError(chapter);
    if (error) status.textContent += `：${error}`;

    rowHead.append(titleGroup, status);

    const preview = document.createElement('span');
    preview.className = 'row-excerpt';
    preview.textContent = chapter.preview || chapter.text;

    const pct = total > 0 ? Math.round((ready / total) * 100) : 0;
    const progressWrap = document.createElement('div');
    progressWrap.className = 'row-progress-wrap';
    const progressBar = document.createElement('div');
    progressBar.className = 'row-progress-bar';
    const progressFill = document.createElement('div');
    progressFill.className = `row-progress-fill ${ready > 0 && ready < total ? 'partial' : ''}`;
    progressFill.style.width = `${pct}%`;
    progressBar.append(progressFill);
    const progressPct = document.createElement('span');
    progressPct.className = 'row-progress-pct';
    progressPct.textContent = `${pct}%`;
    progressWrap.append(progressBar, progressPct);

    const footer = document.createElement('div');
    footer.className = 'row-footer';

    const actions = document.createElement('div');
    actions.className = 'actions';

    const play = document.createElement('button');
    play.type = 'button';
    const chapterSaved = !isPlayingChapter ? getChapterSavedPosition(book, index) : null;
    const hasSavedProgress = Boolean(
      chapterSaved && (chapterSaved.segmentIndex > 0 || chapterSaved.currentTime >= 2),
    );
    if (isPlayingChapter && player && player.playing) {
      play.className = 'primary';
      play.textContent = '暂停播放';
    } else if (canPlay(chapter)) {
      play.className = isPlayingChapter ? 'primary' : '';
      if (isPlayingChapter) play.textContent = '继续播放';
      else if (hasSavedProgress) play.textContent = `继续播放 (第 ${chapterSaved.segmentIndex + 1} 段)`;
      else play.textContent = '播放';
    } else {
      play.textContent = '播放';
    }
    play.disabled = !canPlay(chapter);
    play.addEventListener('click', () => {
      selectedChapterIndex = index;
      if (isPlayingChapter) {
        togglePlayback();
        renderChapters(book);
        return;
      }
      selectChapter(book, index);
    });

    const restartBtn = hasSavedProgress ? document.createElement('button') : null;
    if (restartBtn) {
      restartBtn.type = 'button';
      restartBtn.className = 'ghost-button sm-button';
      restartBtn.textContent = '从头播放';
      restartBtn.addEventListener('click', () => {
        selectedChapterIndex = index;
        selectChapter(book, index, { restart: true });
      });
    }

    const generatingThis = generation
      && generation.bookId === book.id
      && (generation.chapterId === chapter.id || generation.chapterId === null);
    const retry = document.createElement('button');
    retry.type = 'button';
    if (generatingThis) retry.className = 'primary';
    retry.textContent = generatingThis ? '暂停' : (rollup === 'failed' ? '重试' : '生成');
    retry.addEventListener('click', () => {
      selectedChapterIndex = index;
      if (generatingThis) {
        stopGeneration();
        return;
      }
      runGeneration(book.id, chapter.id).catch((err) => setMessage(err.message));
    });

    const readBtn = document.createElement('button');
    readBtn.type = 'button';
    readBtn.className = 'ghost-button sm-button';
    readBtn.textContent = '伴读正文';
    readBtn.addEventListener('click', () => {
      openReaderChapter(book, index);
    });

    actions.append(play);
    if (restartBtn) actions.append(restartBtn);
    actions.append(retry, readBtn);

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'ghost-button sm-button';
    const isExpanded = expandedChapters.has(chapter.id);
    expandBtn.textContent = isExpanded ? `收起段落 (${total})` : `查看段落 (${total})`;
    expandBtn.addEventListener('click', () => {
      if (expandedChapters.has(chapter.id)) expandedChapters.delete(chapter.id);
      else expandedChapters.add(chapter.id);
      renderChapters(book);
    });

    footer.append(actions, expandBtn);
    row.append(rowHead, preview, progressWrap, footer);

    if (isExpanded) {
      const drawer = document.createElement('div');
      drawer.className = 'segments-drawer';
      segmentsOf(chapter).forEach((seg, segIdx) => {
        const segBtn = document.createElement('button');
        segBtn.type = 'button';
        segBtn.className = 'segment-item';
        segBtn.dataset.segmentIndex = String(segIdx);
        const segReady = seg.audio?.status === 'ready';
        if (segReady) segBtn.classList.add('is-playable');
        if (isPlayingChapter && player && player.segmentIndex === segIdx) {
          segBtn.classList.add('is-current-segment');
        }
        segBtn.disabled = !segReady;

        const left = document.createElement('div');
        left.className = 'segment-item-left';
        const idxSpan = document.createElement('span');
        idxSpan.className = 'segment-idx';
        idxSpan.textContent = `#${segIdx + 1}`;
        const txtSpan = document.createElement('span');
        txtSpan.className = 'segment-text';
        txtSpan.textContent = seg.text;
        left.append(idxSpan, txtSpan);

        const tag = document.createElement('span');
        const st = seg.audio?.status || 'pending';
        tag.className = `segment-tag ${st}`;
        tag.textContent = statusLabel[st] || st;

        segBtn.append(left, tag);
        segBtn.addEventListener('click', () => {
          playSegmentAt(book, index, segIdx);
        });
        drawer.append(segBtn);
      });
      row.append(drawer);
    }

    chaptersEl.append(row);
  });
}

function renderReader(book, chapterIndex, force = false) {
  if (!readerEl) return;
  if (!book || !book.chapters || book.chapters.length === 0) {
    readerKey = '';
    readerEl.replaceChildren();
    return;
  }
  const safeIndex = Math.max(0, Math.min(chapterIndex, book.chapters.length - 1));
  selectedChapterIndex = safeIndex;
  const chapter = book.chapters[safeIndex];
  const nextKey = `${book.id}:${chapter.id}`;

  if (readerKey === nextKey && readerEl.firstElementChild && !force) {
    patchReaderStatuses(book, safeIndex);
    return;
  }

  readerKey = nextKey;
  lastHighlightKey = '';
  readerEl.replaceChildren();

  const toolbar = document.createElement('div');
  toolbar.className = 'reader-toolbar';

  const left = document.createElement('div');
  left.className = 'reader-toolbar-left';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'ghost-button sm-button';
  backBtn.textContent = '← 章节列表';
  backBtn.addEventListener('click', () => setStageMode('chapters'));

  const title = document.createElement('h3');
  title.className = 'reader-chapter-title';
  title.textContent = chapter.title;

  const statusPill = document.createElement('span');
  statusPill.id = 'reader-status-pill';
  statusPill.className = `status ${segmentRollup(chapter)}`;
  statusPill.textContent = segmentProgress(chapter);

  left.append(backBtn, title, statusPill);

  const right = document.createElement('div');
  right.className = 'reader-toolbar-right';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.id = 'reader-play-btn';
  playBtn.addEventListener('click', () => {
    const latestBook = resolveBookById(book.id) || book;
    const isPlayingThis = player && playerBookId === latestBook.id && player.index === safeIndex;
    if (isPlayingThis) {
      togglePlayback();
    } else {
      selectChapter(latestBook, safeIndex);
    }
  });

  const genBtn = document.createElement('button');
  genBtn.type = 'button';
  genBtn.id = 'reader-gen-btn';
  genBtn.addEventListener('click', () => {
    const generatingThis = generation
      && generation.bookId === book.id
      && (generation.chapterId === chapter.id || generation.chapterId === null);
    if (generatingThis) {
      stopGeneration();
      return;
    }
    runGeneration(book.id, chapter.id).catch((err) => setMessage(errorMessage(err)));
  });

  const followBtn = document.createElement('button');
  followBtn.type = 'button';
  followBtn.id = 'reader-follow-btn';
  followBtn.className = `ghost-button sm-button reader-follow-btn ${autoFollowEnabled ? 'is-active' : ''}`;
  followBtn.textContent = autoFollowEnabled ? '自动跟随：开' : '自动跟随：关';
  followBtn.addEventListener('click', () => {
    autoFollowEnabled = !autoFollowEnabled;
    try {
      localStorage.setItem('audiobook.autofollow', autoFollowEnabled ? '1' : '0');
    } catch {
      // Ignore storage errors
    }
    followBtn.classList.toggle('is-active', autoFollowEnabled);
    followBtn.textContent = autoFollowEnabled ? '自动跟随：开' : '自动跟随：关';
    if (autoFollowEnabled) syncReadAlongHighlight(true);
  });

  right.append(playBtn, genBtn, followBtn);
  toolbar.append(left, right);

  const waitingBanner = document.createElement('div');
  waitingBanner.id = 'reader-waiting-banner';
  waitingBanner.className = 'reader-waiting-banner';
  waitingBanner.hidden = true;

  const waitingText = document.createElement('span');
  waitingText.id = 'reader-waiting-text';

  const waitingAction = document.createElement('button');
  waitingAction.type = 'button';
  waitingAction.id = 'reader-waiting-action';
  waitingAction.className = 'primary sm-button';
  waitingAction.textContent = '继续生成并续播';
  waitingAction.addEventListener('click', () => {
    if (!generation) {
      runGeneration(book.id, chapter.id).catch((err) => setMessage(errorMessage(err)));
    }
  });

  waitingBanner.append(waitingText, waitingAction);

  const article = document.createElement('div');
  article.className = 'reader-article';

  const groups = groupChapterSegments(chapter);
  for (const group of groups) {
    const para = document.createElement('p');
    para.className = 'reader-paragraph';

    group.segments.forEach((item, idxInGroup) => {
      const st = item.segment.audio?.status || 'pending';
      const segSpan = document.createElement('span');
      segSpan.className = `reader-segment is-${st}`;
      segSpan.dataset.segmentIndex = String(item.segmentIndex);
      segSpan.title = st === 'ready' ? `点击从第 ${item.segmentIndex + 1} 段开始朗读` : `第 ${item.segmentIndex + 1} 段（${statusLabel[st] || st}）`;

      item.sentences.forEach((sentence, sentIdx) => {
        const sentSpan = document.createElement('span');
        sentSpan.className = 'reader-sentence';
        sentSpan.dataset.sentenceIndex = String(sentIdx);
        sentSpan.textContent = sentence;
        segSpan.append(sentSpan);
        if (sentIdx < item.sentences.length - 1) {
          segSpan.append(' ');
        }
      });

      segSpan.addEventListener('click', () => {
        const latestBook = resolveBookById(book.id);
        const latestSeg = latestBook?.chapters?.[safeIndex]?.segments?.[item.segmentIndex];
        if (latestSeg?.audio?.status !== 'ready') {
          setMessage(`第 ${item.segmentIndex + 1} 段尚未生成，点击「生成」可开始合成。`);
          return;
        }
        playSegmentAt(latestBook, safeIndex, item.segmentIndex);
      });

      para.append(segSpan);
      if (idxInGroup < group.segments.length - 1) {
        para.append(' ');
      }
    });

    article.append(para);
  }

  readerEl.append(toolbar, waitingBanner, article);
  patchReaderStatuses(book, safeIndex);
  syncReadAlongHighlight(true);
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function patchReaderStatuses(book, chapterIndex) {
  if (!readerEl || !book?.chapters?.length) return;
  const safeIndex = Math.max(0, Math.min(chapterIndex, book.chapters.length - 1));
  const chapter = book.chapters[safeIndex];
  const expectedKey = `${book.id}:${chapter.id}`;
  if (readerKey !== expectedKey) {
    renderReader(book, safeIndex, true);
    return;
  }

  const statusPill = readerEl.querySelector('#reader-status-pill');
  if (statusPill) {
    const rollup = segmentRollup(chapter);
    statusPill.className = `status ${rollup}`;
    statusPill.textContent = segmentProgress(chapter);
  }

  const playBtn = readerEl.querySelector('#reader-play-btn');
  if (playBtn) {
    const isPlayingThis = player && playerBookId === book.id && player.index === safeIndex;
    const playable = canPlay(chapter);
    playBtn.disabled = !playable;
    if (isPlayingThis && player.playing) {
      playBtn.className = 'primary sm-button';
      playBtn.textContent = '暂停播放';
    } else if (playable) {
      playBtn.className = isPlayingThis ? 'primary sm-button' : 'sm-button';
      playBtn.textContent = isPlayingThis ? '继续播放' : '播放本章';
    } else {
      playBtn.className = 'sm-button';
      playBtn.textContent = '播放本章';
    }
  }

  const genBtn = readerEl.querySelector('#reader-gen-btn');
  if (genBtn) {
    const rollup = segmentRollup(chapter);
    const generatingThis = generation
      && generation.bookId === book.id
      && (generation.chapterId === chapter.id || generation.chapterId === null);
    genBtn.className = generatingThis ? 'primary sm-button' : 'sm-button';
    genBtn.textContent = generatingThis ? '暂停生成' : (rollup === 'failed' ? '重试本章' : '生成本章');
  }

  const waitingBanner = readerEl.querySelector('#reader-waiting-banner');
  const waitingText = readerEl.querySelector('#reader-waiting-text');
  const waitingAction = readerEl.querySelector('#reader-waiting-action');
  if (waitingBanner && waitingText && waitingAction) {
    const isWaitingHere = Boolean(player && player.waiting && player.index === safeIndex);
    waitingBanner.hidden = !isWaitingHere;
    if (isWaitingHere) {
      const n = player.segmentIndex + 1;
      const isGen = generation && generation.bookId === book.id;
      waitingText.textContent = isGen
        ? `已播完前面段落，第 ${n} 段正在生成中，完成后将自动继续播放…`
        : `第 ${n} 段尚未生成，播放已暂停。`;
      waitingAction.hidden = Boolean(isGen);
    }
  }

  const segments = segmentsOf(chapter);
  readerEl.querySelectorAll('.reader-segment').forEach((segSpan) => {
    const idx = Number(segSpan.dataset.segmentIndex);
    const seg = segments[idx];
    if (!seg) return;
    const st = seg.audio?.status || 'pending';
    segSpan.classList.toggle('is-ready', st === 'ready');
    segSpan.classList.toggle('is-pending', st === 'pending');
    segSpan.classList.toggle('is-failed', st === 'failed');
    segSpan.title = st === 'ready' ? `点击从第 ${idx + 1} 段开始朗读` : `第 ${idx + 1} 段（${statusLabel[st] || st}）`;
  });
}

function renderSubtitleBar(book, chapter, segIndex, sentenceIdx, currentTime, duration) {
  if (!subtitleBarEl) return;
  const shouldShow = Boolean(subtitlesEnabled && player && player.index >= 0 && book && chapter);
  if (subtitleBarEl.hidden === shouldShow) {
    subtitleBarEl.hidden = !shouldShow;
    document.body.classList.toggle('has-subtitles', shouldShow);
  }
  if (!shouldShow) {
    lastSubtitleKey = '';
    return;
  }

  const segments = segmentsOf(chapter);
  const segment = segments[segIndex];
  if (!segment) return;

  const isWaiting = Boolean(player.waiting);
  const isGen = Boolean(generation && generation.bookId === book.id);
  const subtitleKey = `${book.id}:${chapter.id}:${segIndex}:${sentenceIdx}:${isWaiting ? 1 : 0}:${isGen ? 1 : 0}`;
  if (subtitleKey !== lastSubtitleKey) {
    lastSubtitleKey = subtitleKey;
    const n = segIndex + 1;
    const m = segments.length;
    subtitleMetaEl.textContent = `第 ${n} / ${m} 段`;

    const sentences = splitSentences(segmentFullText(segment));
    subtitleTextEl.replaceChildren();
    sentences.forEach((sentence, idx) => {
      const span = document.createElement('span');
      span.className = 'subtitle-sentence';
      if (idx === sentenceIdx) span.classList.add('is-active');
      else if (idx < sentenceIdx) span.classList.add('is-spoken');
      span.textContent = sentence;
      subtitleTextEl.append(span);
      if (idx < sentences.length - 1) subtitleTextEl.append(' ');
    });

    if (isWaiting) {
      const tag = document.createElement('span');
      tag.className = 'subtitle-waiting-tag';
      tag.textContent = isGen ? '（等待下一段生成中…）' : '（本段尚未生成）';
      subtitleTextEl.append(tag);
    }
  }

  const pct = duration > 0 ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;
  if (subtitleProgressFillEl) {
    subtitleProgressFillEl.style.width = `${pct.toFixed(1)}%`;
  }
}

function syncReadAlongHighlight(shouldScroll = false) {
  const book = activeBook;
  const chapterIndex = player ? player.index : -1;
  const segIndex = player ? player.segmentIndex : -1;
  const chapter = book && chapterIndex >= 0 ? book.chapters?.[chapterIndex] : null;
  const segment = chapter ? segmentsOf(chapter)[segIndex] : null;
  const { currentTime, duration } = player ? player.progress() : { currentTime: 0, duration: 0 };
  const sentences = segment ? splitSentences(segmentFullText(segment)) : [];
  const sentenceIdx = activeSentenceIndex(sentences, currentTime, duration);

  renderSubtitleBar(book, chapter, segIndex, sentenceIdx, currentTime, duration);

  if (stageMode !== 'reader' || !readerEl || !book || !chapter) return;
  const expectedKey = `${book.id}:${chapter.id}`;
  if (readerKey !== expectedKey) return;

  const highlightKey = `${chapterIndex}:${segIndex}:${sentenceIdx}`;
  const changed = highlightKey !== lastHighlightKey;

  if (changed || shouldScroll) {
    readerEl.querySelectorAll('.reader-segment.is-active-segment').forEach((el) => {
      el.classList.remove('is-active-segment');
    });
    readerEl.querySelectorAll('.reader-paragraph.has-active-segment').forEach((el) => {
      el.classList.remove('has-active-segment');
    });
    readerEl.querySelectorAll('.reader-sentence.is-active-sentence, .reader-sentence.is-spoken-sentence').forEach((el) => {
      el.classList.remove('is-active-sentence', 'is-spoken-sentence');
    });

    const activeSegEl = readerEl.querySelector(`.reader-segment[data-segment-index="${segIndex}"]`);
    if (activeSegEl) {
      activeSegEl.classList.add('is-active-segment');
      const paraEl = activeSegEl.closest('.reader-paragraph');
      if (paraEl) paraEl.classList.add('has-active-segment');

      let activeSentEl = null;
      activeSegEl.querySelectorAll('.reader-sentence').forEach((sentEl) => {
        const idx = Number(sentEl.dataset.sentenceIndex);
        if (idx === sentenceIdx) {
          sentEl.classList.add('is-active-sentence');
          activeSentEl = sentEl;
        } else if (idx < sentenceIdx) {
          sentEl.classList.add('is-spoken-sentence');
        }
      });

      if ((shouldScroll || changed) && autoFollowEnabled) {
        const target = activeSentEl || activeSegEl;
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }
    lastHighlightKey = highlightKey;
  }
}

function renderLibrary() {
  libraryEl.replaceChildren();
  if (library.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'meta';
    empty.textContent = '还没有书籍。请在右侧面板导入 PDF、网页或 URL。';
    libraryEl.append(empty);
    return;
  }
  for (const book of library) {
    const isThisBookActive = activeBook && activeBook.id === book.id;
    const block = document.createElement('article');
    block.className = `card book-shelf-card ${isThisBookActive ? 'is-active-book' : ''}`;
    block.dataset.bookId = book.id;

    const header = document.createElement('div');
    header.className = 'book-shelf-header';

    const titleRow = document.createElement('div');
    titleRow.className = 'book-shelf-title-row';
    const title = document.createElement('strong');
    title.textContent = book.title;
    const sourceTag = document.createElement('span');
    sourceTag.className = 'source-tag';
    sourceTag.textContent = book.source.kind === 'pdf' ? 'PDF' : '网页';
    titleRow.append(title, sourceTag);

    const { ready, total } = bookSegmentCounts(book);
    const pct = total > 0 ? Math.round((ready / total) * 100) : 0;

    const meta = document.createElement('div');
    meta.className = 'book-shelf-meta';
    const metaLabel = document.createElement('span');
    metaLabel.textContent = `${book.chapters.length} 章 · ${ready}/${total} 段就绪`;
    const metaPct = document.createElement('span');
    metaPct.textContent = `${pct}%`;
    meta.append(metaLabel, metaPct);

    const track = document.createElement('div');
    track.className = 'mini-progress-track';
    const fill = document.createElement('div');
    fill.className = 'mini-progress-fill';
    fill.style.width = `${pct}%`;
    track.append(fill);

    header.append(titleRow, meta, track);
    const bookSaved = getBookSavedPosition(book);
    if (bookSaved) {
      const savedCh = book.chapters[bookSaved.chapterIndex];
      const totalSegs = segmentsOf(savedCh).length;
      const resumeRow = document.createElement('div');
      resumeRow.className = 'book-resume-hint';
      resumeRow.textContent = `上次播至：${savedCh?.title || ''} · 第 ${bookSaved.segmentIndex + 1}/${totalSegs} 段`;
      header.append(resumeRow);
    }
    header.addEventListener('click', () => {
      switchToBook(book);
    });
    block.append(header);

    const tocList = document.createElement('div');
    tocList.className = 'toc-list';

    book.chapters.forEach((chapter, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'card toc-item';
      button.dataset.chapterId = chapter.id;
      const isPlayingThis = player && playerBookId === book.id && player.index === index;
      const isSelectedThis = isThisBookActive && selectedChapterIndex === index;
      if (isPlayingThis || isSelectedThis) {
        button.classList.add('active');
      }

      const left = document.createElement('div');
      left.className = 'toc-item-left';
      const idx = document.createElement('span');
      idx.className = 'toc-index';
      idx.textContent = String(index + 1).padStart(2, '0');
      const name = document.createElement('strong');
      name.className = 'toc-name';
      name.textContent = chapter.title;
      left.append(idx, name);

      const badgeInfo = compactTocBadge(chapter, isPlayingThis);
      const state = document.createElement('span');
      state.className = `toc-badge ${badgeInfo.cls}`;
      state.textContent = badgeInfo.text;

      button.append(left, state);
      button.addEventListener('click', () => openBookChapter(book, index));
      tocList.append(button);
    });

    block.append(tocList);
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
  const deleteEl = document.querySelector('#delete-voice');
  if (deleteEl) deleteEl.disabled = !voiceConfigured;
  const hasServiceUrl = Boolean(ttsUrlEl && ttsUrlEl.value.trim());
  if (voiceConfigured) {
    const label = voiceName ? `自定义音色：${voiceName}` : '已上传自定义音色';
    voiceStateEl.textContent = label;
    voiceStateEl.classList.add('is-ready');
    if (headerVoicePillEl) headerVoicePillEl.classList.add('is-ready');
    if (headerVoiceTextEl) headerVoiceTextEl.textContent = voiceName ? `自定义音色 · ${voiceName}` : '自定义音色已就绪';
    if (ttsBadgeEl) {
      ttsBadgeEl.textContent = '自定义音色';
      ttsBadgeEl.className = 'panel-badge ready';
    }
    return;
  }
  voiceStateEl.textContent = hasServiceUrl
    ? '当前使用服务默认音色（也可上传 wav 替换）'
    : '还没有音色样本。选一个 wav，再点上传。';
  voiceStateEl.classList.toggle('is-ready', hasServiceUrl);
  if (headerVoicePillEl) headerVoicePillEl.classList.toggle('is-ready', hasServiceUrl);
  if (headerVoiceTextEl) {
    headerVoiceTextEl.textContent = hasServiceUrl ? '服务默认音色已就绪' : '未配置音色服务';
  }
  if (ttsBadgeEl) {
    ttsBadgeEl.textContent = hasServiceUrl ? '默认音色' : '待配置';
    ttsBadgeEl.className = hasServiceUrl ? 'panel-badge ready' : 'panel-badge accent';
  }
}

function patchBookSummaryUI(book) {
  if (!book) return;
  const bookCard = libraryEl?.querySelector(`.book-shelf-card[data-book-id="${book.id}"]`);
  if (bookCard) {
    const { ready, total } = bookSegmentCounts(book);
    const pct = total > 0 ? Math.round((ready / total) * 100) : 0;
    const metaSpans = bookCard.querySelectorAll('.book-shelf-meta span');
    if (metaSpans.length >= 2) {
      metaSpans[0].textContent = `${book.chapters.length} 章 · ${ready}/${total} 段就绪`;
      metaSpans[1].textContent = `${pct}%`;
    }
    const fill = bookCard.querySelector('.mini-progress-fill');
    if (fill) fill.style.width = `${pct}%`;
    const resumeRow = bookCard.querySelector('.book-resume-hint');
    const bookSaved = getBookSavedPosition(book);
    if (resumeRow && bookSaved) {
      const savedCh = book.chapters[bookSaved.chapterIndex];
      const totalSegs = segmentsOf(savedCh).length;
      resumeRow.textContent = `上次播至：${savedCh?.title || ''} · 第 ${bookSaved.segmentIndex + 1}/${totalSegs} 段`;
    }
    book.chapters.forEach((chapter, index) => {
      const tocBtn = bookCard.querySelector(`.toc-item[data-chapter-id="${chapter.id}"]`);
      if (!tocBtn) return;
      const isPlayingThis = Boolean(player && playerBookId === book.id && player.index === index);
      const badgeInfo = compactTocBadge(chapter, isPlayingThis);
      const badge = tocBtn.querySelector('.toc-badge');
      if (badge) {
        badge.className = `toc-badge ${badgeInfo.cls}`;
        badge.textContent = badgeInfo.text;
      }
    });
  }
}

function patchChapterCardInPlace(book, chapter, index, updatedSegs) {
  const row = chaptersEl?.querySelector(`.row[data-chapter-id="${chapter.id}"]`);
  if (!row) return;
  const rollup = segmentRollup(chapter);
  const { ready, total } = segmentCounts(chapter);
  const pct = total > 0 ? Math.round((ready / total) * 100) : 0;
  const statusEl = row.querySelector('.status');
  if (statusEl) {
    statusEl.className = `status ${rollup}`;
    statusEl.textContent = segmentProgress(chapter);
    const error = segmentError(chapter);
    if (error) statusEl.textContent += `：${error}`;
  }
  const fill = row.querySelector('.row-progress-fill');
  if (fill) {
    fill.className = `row-progress-fill ${ready > 0 && ready < total ? 'partial' : ''}`;
    fill.style.width = `${pct}%`;
  }
  const pctEl = row.querySelector('.row-progress-pct');
  if (pctEl) pctEl.textContent = `${pct}%`;
  const actions = row.querySelector('.row-footer .actions');
  const playBtn = actions?.querySelector('button');
  if (playBtn) playBtn.disabled = !canPlay(chapter);

  const drawer = row.querySelector('.segments-drawer');
  if (drawer && Array.isArray(updatedSegs)) {
    for (const item of updatedSegs) {
      if (item.chapterId !== chapter.id) continue;
      const segBtn = drawer.querySelector(`.segment-item[data-segment-index="${item.segmentIndex}"]`);
      if (!segBtn) continue;
      const st = item.audio?.status || 'pending';
      segBtn.classList.toggle('is-playable', st === 'ready');
      segBtn.disabled = st !== 'ready';
      const tag = segBtn.querySelector('.segment-tag');
      if (tag) {
        tag.className = `segment-tag ${st}`;
        tag.textContent = statusLabel[st] || st;
      }
    }
  }
}

function applyCompactDelta(bookId, updatedSegments) {
  const book = library.find((item) => item.id === bookId)
    || (activeBook && activeBook.id === bookId ? activeBook : null);
  if (!book) return;
  const touchedChapters = new Set();
  for (const item of updatedSegments || []) {
    const chapter = book.chapters.find((c) => c.id === item.chapterId);
    if (!chapter) continue;
    const seg = chapter.segments?.[item.segmentIndex]?.id === item.segmentId
      ? chapter.segments[item.segmentIndex]
      : chapter.segments?.find((s) => s.id === item.segmentId);
    if (!seg) continue;
    seg.audio = {
      status: item.audio.status,
      bytes: item.audio.bytes,
      error: item.audio.error,
    };
    touchedChapters.add(chapter);
  }
  if (activeBook && activeBook.id === book.id) activeBook = book;

  let resumed = false;
  if (player && playerBookId === book.id) {
    player.updateChapters(book.chapters);
    if (player.index >= 0 && player.waiting) {
      const waitedSeg = book.chapters[player.index]?.segments?.[player.segmentIndex];
      if (waitedSeg?.audio?.status === 'ready') {
        if (player.reloadCurrent()) {
          resumed = true;
          waitingMessageShown = false;
          setMessage('');
          resumePlayback();
        }
      }
    }
  }

  patchBookSummaryUI(book);
  if (activeBook && activeBook.id === book.id) {
    if (stageMode === 'reader') {
      patchReaderStatuses(book, selectedChapterIndex);
      syncReadAlongHighlight(resumed);
    } else {
      const { ready: bookReady, total: bookTotal } = bookSegmentCounts(book);
      const bookPct = bookTotal > 0 ? Math.round((bookReady / bookTotal) * 100) : 0;
      const heroChips = chaptersEl.querySelectorAll('.book-hero-stats .stat-chip');
      if (heroChips.length >= 2) {
        heroChips[1].textContent = `共 ${book.chapters.length} 章 · ${bookReady} / ${bookTotal} 段已就绪 (${bookPct}%)`;
      }
      const heroFill = chaptersEl.querySelector('.book-hero .mini-progress-fill');
      if (heroFill) heroFill.style.width = `${bookPct}%`;
      for (const ch of touchedChapters) {
        const chIdx = book.chapters.indexOf(ch);
        patchChapterCardInPlace(book, ch, chIdx, updatedSegments);
      }
    }
  }
}

function rememberBook(book) {
  activeBook = book;
  const index = library.findIndex((item) => item.id === book.id);
  if (index >= 0) library[index] = book;

  let resumed = false;
  if (player && playerBookId === book.id) {
    player.updateChapters(book.chapters);
    if (player.index >= 0 && player.waiting) {
      const waitedSeg = book.chapters[player.index]?.segments?.[player.segmentIndex];
      if (waitedSeg?.audio?.status === 'ready') {
        if (player.reloadCurrent()) {
          resumed = true;
          waitingMessageShown = false;
          setMessage('');
          resumePlayback();
        }
      }
    }
  }

  renderLibrary();
  if (stageMode === 'reader') {
    patchReaderStatuses(book, selectedChapterIndex);
    syncReadAlongHighlight(resumed);
  } else {
    renderChapters(book);
  }
}

async function loadLibrary() {
  const response = await fetch('/api/library');
  const payload = await readJson(response);
  library = payload.books;
  mergeProgressStore(payload.progress);
  applyTts(payload.tts);
  if (activeBook) {
    activeBook = library.find((book) => book.id === activeBook.id) || activeBook;
  } else if (library.length > 0) {
    activeBook = library.find((book) => book.id === progressStore.lastBookId) || library[0];
  }
  if (player && activeBook && playerBookId === activeBook.id) {
    player.updateChapters(activeBook.chapters);
  } else if (!player && activeBook) {
    restoreBookPosition(activeBook, { autoplay: false });
  }
  if (stageMode === 'reader' && activeBook) {
    renderReader(activeBook, selectedChapterIndex, false);
  } else {
    renderChapters(activeBook);
  }
  renderLibrary();
  syncReadAlongHighlight(false);
}

function unbindPlayer() {
  if (player) {
    player.pause();
    player.destroy?.();
  }
  player = null;
  playerBookId = '';
  lastRenderedChapterKey = '';
  toggleEl.textContent = '播放';
  updateVisualizerState();
  stopProgressLoop();
  lastTimeText = '';
  lastSeekValue = '';
  if (timeEl) timeEl.textContent = '0:00 / 0:00';
  if (seekEl) seekEl.value = '0';
}

function bindPlayer(book, index) {
  if (player) {
    player.pause();
    player.destroy?.();
  }
  activeBook = book;
  playerBookId = book.id;
  lastRenderedChapterKey = '';
  player = createPlayer({
    audio,
    bookId: book.id,
    chapters: book.chapters,
    prefetch: true,
    onPosition: (position) => showPosition(book.id, position),
    onWaiting: (position) => handlePlayerWaiting(book.id, position),
    onError: (error) => handlePlayerError(error),
  });
  applySpeed();
  if (index >= 0) player.load(index);
}

function restoreBookPosition(book, { autoplay = false } = {}) {
  const saved = getBookSavedPosition(book);
  if (!saved) return false;
  restoringPosition = true;
  try {
    selectedChapterIndex = saved.chapterIndex;
    bindPlayer(book, -1);
    if (saved.segmentIndex === 0 && !(saved.currentTime > 0)) {
      player.load(saved.chapterIndex);
    } else {
      player.loadSegment(saved.chapterIndex, saved.segmentIndex, { startTime: saved.currentTime });
    }
    renderProgress();
    syncReadAlongHighlight(false);
    if (autoplay) resumePlayback();
  } finally {
    restoringPosition = false;
  }
  return true;
}

function switchToBook(book) {
  if (activeBook && activeBook.id === book.id) {
    setStageMode(stageMode);
    renderLibrary();
    switchMobileView('stage');
    return;
  }
  saveCurrentProgress({ syncServer: true });
  const wasPlaying = Boolean(player && player.playing);
  activeBook = book;
  const saved = getBookSavedPosition(book);
  if (saved) {
    restoreBookPosition(book, { autoplay: wasPlaying });
    if (stageMode === 'reader') renderReader(book, selectedChapterIndex, true);
    else renderChapters(book);
  } else {
    unbindPlayer();
    selectedChapterIndex = 0;
    nowEl.textContent = '未选择章节';
    downloadEl.hidden = true;
    setStageMode('chapters');
    syncReadAlongHighlight(false);
  }
  renderLibrary();
  switchMobileView('stage');
}

function applySpeed() {
  if (!player || !speedEl) return;
  player.setRate(Number(speedEl.value));
}

function updateVisualizerState() {
  if (!visualizerEl) return;
  visualizerEl.classList.toggle('is-playing', Boolean(player && player.playing));
}

function startProgressLoop() {
  if (progressRaf !== null) return;
  const tick = () => {
    progressRaf = null;
    if (!player || !player.playing || audio.paused) return;
    renderProgress();
    syncReadAlongHighlight(false);
    progressRaf = requestAnimationFrame(tick);
  };
  progressRaf = requestAnimationFrame(tick);
}

function stopProgressLoop() {
  if (progressRaf === null) return;
  cancelAnimationFrame(progressRaf);
  progressRaf = null;
}

function syncStageControls() {
  if (!activeBook) return;
  if (stageMode === 'reader') {
    patchReaderStatuses(activeBook, selectedChapterIndex);
  } else {
    renderChapters(activeBook);
  }
}

function resumePlayback() {
  if (!player || skipResume) return;
  const pending = player.resume();
  if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  if (player.playing) {
    if (waitingMessageShown) {
      waitingMessageShown = false;
      setMessage(generation && generation.mode === 'manual' ? '正在逐段生成，可点暂停。' : '');
    }
    toggleEl.textContent = '暂停';
    updateVisualizerState();
    startProgressLoop();
    syncStageControls();
    maybeAutoPregenerate();
  }
}

function togglePlayback() {
  if (!player || player.index < 0) return;
  if (player.playing) {
    skipResume = true;
    saveCurrentProgress({ syncServer: true });
    player.pause();
    toggleEl.textContent = '播放';
    updateVisualizerState();
    stopProgressLoop();
    if (stageMode === 'reader' && activeBook) patchReaderStatuses(activeBook, selectedChapterIndex);
    return;
  }
  skipResume = false;
  const chapter = activeBook?.chapters?.[player.index];
  const segment = chapter?.segments?.[player.segmentIndex];
  if (segment && segment.audio?.status !== 'ready') {
    player.reloadCurrent();
    if (!generation && activeBook && chapter) {
      setMessage(`第 ${player.segmentIndex + 1} 段尚未生成，正在自动生成，完成后立即续播…`);
      runGeneration(activeBook.id, chapter.id).catch((error) => setMessage(error.message));
    }
    return;
  }
  resumePlayback();
  if (stageMode === 'reader' && activeBook) patchReaderStatuses(activeBook, selectedChapterIndex);
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
      if (player) player.pause();
      else audio.pause();
      updateVisualizerState();
      stopProgressLoop();
      setMessage('睡眠定时已到');
    }, Number(value) * 60 * 1000);
    return;
  }
  if (value === 'chapter') sleepChapterIndex = player ? player.index : -1;
}

function handlePlayerWaiting(bookId, position) {
  toggleEl.textContent = '播放';
  updateVisualizerState();
  stopProgressLoop();
  const book = resolveBookById(bookId);
  const n = position.segmentIndex + 1;
  waitingMessageShown = true;
  if (generation && generation.bookId === bookId) {
    setMessage(`第 ${n} 段正在生成中，生成完成后自动继续播放…`);
  } else if (autoGenerateEnabled) {
    setMessage(`第 ${n} 段正在后台自动生成，完成后立即续播…`);
    maybeAutoPregenerate();
  } else {
    setMessage(`第 ${n} 段尚未生成，点击「播放」或「生成」可继续合成并自动续播。`);
  }
  if (book) {
    if (stageMode === 'reader') patchReaderStatuses(book, selectedChapterIndex);
    else renderChapters(book);
  }
  syncReadAlongHighlight(false);
}

function handlePlayerError() {
  toggleEl.textContent = '播放';
  updateVisualizerState();
  stopProgressLoop();
  setMessage('音频加载中断，点击「播放」可重试当前段。');
  if (stageMode === 'reader' && activeBook) {
    patchReaderStatuses(activeBook, selectedChapterIndex);
  }
}

function showPosition(bookId, position) {
  skipResume = false;
  const book = resolveBookById(bookId);
  if (!book) return;
  const chapter = book.chapters[position.chapterIndex];
  if (!chapter) return;
  selectedChapterIndex = position.chapterIndex;
  const n = position.segmentIndex + 1;
  const m = position.segmentCount;
  nowEl.textContent = `${book.title} · ${chapter.title} · 第 ${n} / ${m} 段`;
  const segment = segmentsOf(chapter)[position.segmentIndex];
  if (segment) {
    downloadEl.hidden = false;
    downloadEl.href = `/api/books/${book.id}/chapters/${chapter.id}/segments/${segment.id}/audio?download=1`;
  }
  const chapterKey = `${book.id}:${position.chapterIndex}`;
  if (!restoringPosition && segment?.audio?.status === 'ready') {
    const initialSeek = player && player.pendingSeek > 0 ? player.pendingSeek : 0;
    saveCurrentProgress({ syncServer: true, currentTimeOverride: initialSeek });
  }
  if (chapterKey === lastRenderedChapterKey) {
    patchBookSummaryUI(book);
    if (stageMode === 'reader') {
      patchReaderStatuses(book, selectedChapterIndex);
    } else {
      const row = chaptersEl?.querySelector(`.row[data-chapter-id="${chapter.id}"]`);
      const drawer = row?.querySelector('.segments-drawer');
      if (drawer) {
        drawer.querySelectorAll('.segment-item.is-current-segment').forEach((el) => {
          el.classList.remove('is-current-segment');
        });
        const curBtn = drawer.querySelector(`.segment-item[data-segment-index="${position.segmentIndex}"]`);
        if (curBtn) curBtn.classList.add('is-current-segment');
      }
    }
  } else {
    lastRenderedChapterKey = chapterKey;
    renderLibrary();
    if (stageMode === 'reader') {
      renderReader(book, selectedChapterIndex, false);
    } else {
      renderChapters(book);
    }
  }
  syncReadAlongHighlight(true);
  if (!restoringPosition) {
    maybeAutoPregenerate();
  }
  if (sleepChapterIndex !== null && position.chapterIndex > sleepChapterIndex) {
    resetSleepControl();
    if (player) player.pause();
    updateVisualizerState();
    stopProgressLoop();
    setMessage('本章已播完');
    skipResume = true;
    return false;
  }
}

function selectChapter(book, index, { restart = false } = {}) {
  const current = library.find((item) => item.id === book.id) || book;
  if (player && (playerBookId !== current.id || player.index !== index)) {
    saveCurrentProgress({ syncServer: true });
  }
  selectedChapterIndex = index;
  skipResume = false;
  const saved = restart ? null : getChapterSavedPosition(current, index);
  const targetSegment = saved ? saved.segmentIndex : firstReadySegmentIndex(current.chapters[index]);
  const startTime = saved ? saved.currentTime : 0;

  if (!player || playerBookId !== current.id) {
    bindPlayer(current, -1);
    if (targetSegment === 0 && !(startTime > 0)) player.load(index);
    else player.loadSegment(index, targetSegment, { startTime });
  } else {
    player.updateChapters(current.chapters);
    if (targetSegment === 0 && !(startTime > 0)) player.load(index);
    else player.loadSegment(index, targetSegment, { startTime });
  }
  resumePlayback();
}

function playSegmentAt(book, chapterIndex, segmentIndex) {
  const current = library.find((item) => item.id === book.id) || book;
  if (player && (playerBookId !== current.id || player.index !== chapterIndex)) {
    saveCurrentProgress({ syncServer: true });
  }
  selectedChapterIndex = chapterIndex;
  skipResume = false;
  if (!player || playerBookId !== current.id) {
    bindPlayer(current, -1);
  } else {
    player.updateChapters(current.chapters);
  }
  player.loadSegment(chapterIndex, segmentIndex, { startTime: 0 });
  resumePlayback();
}

function openReaderChapter(book, index) {
  const sameBook = activeBook && activeBook.id === book.id;
  if (!sameBook) saveCurrentProgress({ syncServer: true });
  activeBook = book;
  selectedChapterIndex = index;
  switchMobileView('stage');
  setStageMode('reader', { focusHighlight: true });
  if (player && playerBookId === book.id && player.index === index) {
    syncReadAlongHighlight(true);
    return;
  }
  if (canPlay(book.chapters[index])) {
    setMessage('');
    selectChapter(book, index);
  }
}

function scrollToChapterCard(index) {
  const card = chaptersEl.querySelector(`[data-chapter-index="${index}"]`);
  if (card && typeof card.scrollIntoView === 'function') {
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function openBookChapter(book, index) {
  if (player && playerBookId === book.id && player.index === index && canPlay(book.chapters[index])) {
    activeBook = book;
    selectedChapterIndex = index;
    switchMobileView('stage');
    if (stageMode === 'reader') {
      renderReader(book, index, false);
    } else {
      renderChapters(book);
      scrollToChapterCard(index);
    }
    renderLibrary();
    if (!player.playing) resumePlayback();
    return;
  }
  saveCurrentProgress({ syncServer: true });
  activeBook = book;
  selectedChapterIndex = index;
  chapterFilter = 'all';
  if (chapterFiltersEl) {
    chapterFiltersEl.querySelectorAll('.filter-pill').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.filter === 'all');
    });
  }
  switchMobileView('stage');
  if (stageMode === 'reader') {
    renderReader(book, index, true);
  } else {
    renderChapters(book);
    scrollToChapterCard(index);
  }
  renderLibrary();
  if (!canPlay(book.chapters[index])) {
    setMessage('这一章还没有可播放的片段，可点击该章的“生成”按钮开始合成。');
    unbindPlayer();
    nowEl.textContent = `${book.title} · ${book.chapters[index].title}`;
    downloadEl.hidden = true;
    syncReadAlongHighlight(false);
    return;
  }
  setMessage('');
  selectChapter(book, index);
}

function stopGeneration() {
  if (!generation) return Promise.resolve();
  generation.controller.abort();
  return generation.finished;
}

async function runGeneration(bookId, chapterId, { mode = 'manual', startIndex = 0 } = {}) {
  if (clearingLibraryAudio) return;
  if (generation) {
    if (mode === 'auto') return;
    await stopGeneration();
  }
  const controller = new AbortController();
  let resolveFinished = () => {};
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });
  generation = { controller, finished, bookId, chapterId, mode };
  updateAutogenToggleUI();
  if (mode === 'manual') {
    if (activeBook) {
      if (stageMode === 'reader') patchReaderStatuses(activeBook, selectedChapterIndex);
      else renderChapters(activeBook);
    }
    setMessage(chapterId ? '正在生成这一章，可点暂停后再生成其他章。' : '正在逐段生成，可点暂停。');
  }
  let stopped = false;
  let errorOccurred = false;
  try {
    let done = false;
    while (!controller.signal.aborted && !done) {
      let fromSegmentIndex = startIndex;
      if (mode === 'auto') {
        const currentBook = resolveBookById(bookId);
        const playingChapter = currentBook?.chapters?.[player?.index ?? -1];
        if (!player || playerBookId !== bookId || playingChapter?.id !== chapterId || (!player.playing && !player.waiting) || !autoGenerateEnabled) {
          break;
        }
        fromSegmentIndex = Math.max(0, player.segmentIndex);
        if (readyAheadCount(playingChapter, fromSegmentIndex) >= PREGEN_TARGET || !hasPendingWithinTarget(playingChapter, fromSegmentIndex)) {
          break;
        }
      }
      const path = chapterId
        ? `/api/books/${bookId}/chapters/${chapterId}/generate`
        : `/api/books/${bookId}/generate`;
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          limit: 1,
          compact: true,
          fromSegmentIndex,
          skipFailed: mode === 'auto',
        }),
        signal: controller.signal,
      });
      const payload = await readJson(response);
      if (Array.isArray(payload.updatedSegments)) {
        applyCompactDelta(bookId, payload.updatedSegments);
        if (mode === 'auto' && payload.updatedSegments.some((item) => item.audio?.status === 'failed')) {
          break;
        }
      } else if (payload.book) {
        rememberBook(payload.book);
      }
      done = payload.done === true;
    }
    stopped = controller.signal.aborted;
  } catch (error) {
    if (error.name === 'AbortError') stopped = true;
    else {
      errorOccurred = true;
      setMessage(error.message);
    }
  } finally {
    const wasManual = generation?.mode !== 'auto';
    generation = null;
    resolveFinished();
    updateAutogenToggleUI();
    syncStageControls();
    if (wasManual && !errorOccurred) {
      if (stopped) setMessage('已暂停生成。可以生成其他章节。');
      else if (chapterId) setMessage('这一章已处理。');
      else setMessage('段落片段已写入资料库。');
    }
  }
}

async function generateCurrent() {
  if (!activeBook) return;
  if (generation) {
    await stopGeneration();
    return;
  }
  await runGeneration(activeBook.id, null);
}

async function deleteVoice() {
  await stopGeneration();
  const response = await fetch('/api/voice', { method: 'DELETE' });
  const payload = await readJson(response);
  applyTts(payload.tts);
  await loadLibrary();
  setMessage('自定义音色已移除。已有音频保留，新生成的音频使用服务默认音色。');
}

async function clearLibraryAudio() {
  if (clearingLibraryAudio) return;
  await confirmLibraryAudioClear((message) => window.confirm(message), async () => {
    clearingLibraryAudio = true;
    clearLibraryAudioEl.disabled = true;
    try {
      saveCurrentProgress({ syncServer: true });
      await stopGeneration();
      unbindPlayer();
      downloadEl.hidden = true;
      const response = await fetch('/api/library/audio/clear', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: 'all-generated-audio' }),
      });
      await readJson(response);
      await loadLibrary();
      setMessage('资料库中所有已生成音频已清空。书籍、正文、播放进度和音色样本已保留。');
    } finally {
      clearingLibraryAudio = false;
      clearLibraryAudioEl.disabled = false;
    }
  });
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
  const nextTimeText = `${formatTime(currentTime)} / ${formatTime(duration)}`;
  if (nextTimeText !== lastTimeText) {
    lastTimeText = nextTimeText;
    timeEl.textContent = nextTimeText;
  }
  if (!seekEl.matches(':active')) {
    const nextSeekValue = duration > 0 ? String(Math.round((currentTime / duration) * 1000)) : '0';
    if (nextSeekValue !== lastSeekValue) {
      lastSeekValue = nextSeekValue;
      seekEl.value = nextSeekValue;
    }
  }
}

// Import mode tabs
document.querySelectorAll('.import-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.importTab;
    document.querySelectorAll('.import-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.importTab === mode);
    });
    document.querySelectorAll('.import-pane').forEach((pane) => {
      pane.hidden = pane.dataset.importPane !== mode;
    });
  });
});

// Mobile workspace tabs
document.querySelectorAll('.mobile-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    switchMobileView(tab.dataset.mobileView);
  });
});

// Stage view mode tabs (章节列表 / 伴读正文)
if (stageModeTabsEl) {
  stageModeTabsEl.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const nextMode = tab.dataset.stageMode;
      if (nextMode === 'reader' && player && activeBook && player.index >= 0) {
        selectedChapterIndex = player.index;
      }
      setStageMode(nextMode, { focusHighlight: nextMode === 'reader' });
    });
  });
}

// Chapter filter pills
if (chapterFiltersEl) {
  chapterFiltersEl.querySelectorAll('.filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      chapterFilter = pill.dataset.filter || 'all';
      chapterFiltersEl.querySelectorAll('.filter-pill').forEach((btn) => {
        btn.classList.toggle('active', btn === pill);
      });
      if (activeBook) renderChapters(activeBook);
    });
  });
}

// Subtitle controls
if (subtitleToggleEl) {
  updateSubtitleToggleUI();
  subtitleToggleEl.addEventListener('click', () => {
    subtitlesEnabled = !subtitlesEnabled;
    try {
      localStorage.setItem('audiobook.subtitles', subtitlesEnabled ? '1' : '0');
    } catch {
      // Ignore storage errors
    }
    updateSubtitleToggleUI();
    syncReadAlongHighlight(false);
  });
}

// Auto look-ahead pre-generation toggle
if (autogenToggleEl) {
  updateAutogenToggleUI();
  autogenToggleEl.addEventListener('click', () => {
    autoGenerateEnabled = !autoGenerateEnabled;
    try {
      localStorage.setItem('audiobook.autogen', autoGenerateEnabled ? '1' : '0');
    } catch {
      // Ignore storage errors
    }
    updateAutogenToggleUI();
    if (autoGenerateEnabled) {
      maybeAutoPregenerate();
    } else if (generation && generation.mode === 'auto') {
      stopGeneration();
    }
  });
}

function locateCurrentInReader() {
  if (!activeBook) return;
  if (player && player.index >= 0) selectedChapterIndex = player.index;
  switchMobileView('stage');
  setStageMode('reader', { focusHighlight: true });
}

if (subtitleLocateEl) {
  subtitleLocateEl.addEventListener('click', locateCurrentInReader);
}
if (subtitleTextEl) {
  subtitleTextEl.addEventListener('click', locateCurrentInReader);
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
document.querySelector('#delete-voice').addEventListener('click', () => {
  deleteVoice().catch((error) => setMessage(error.message));
});
clearLibraryAudioEl.addEventListener('click', () => {
  clearLibraryAudio().catch((error) => setMessage(error.message));
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
  skipResume = false;
  if (player.previous()) resumePlayback();
});
document.querySelector('#next').addEventListener('click', () => {
  if (!player) return;
  skipResume = false;
  if (player.next()) resumePlayback();
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
  if (player && player.playing) {
    toggleEl.textContent = '暂停';
    startProgressLoop();
  } else {
    player?.pause();
  }
  updateVisualizerState();
  syncStageControls();
});
audio.addEventListener('pause', () => {
  if (!player || !player.playing) {
    toggleEl.textContent = '播放';
    if (!restoringPosition) saveCurrentProgress({ syncServer: true });
  }
  updateVisualizerState();
  stopProgressLoop();
  syncStageControls();
});
audio.addEventListener('error', () => {
  if (player && player.playing) player.pause();
  handlePlayerError();
});
audio.addEventListener('timeupdate', () => {
  renderProgress();
  syncReadAlongHighlight(false);
  if (player && player.playing && !audio.paused && !restoringPosition && Date.now() - lastLocalSaveAt >= 1000) {
    saveCurrentProgress();
  }
});
audio.addEventListener('durationchange', () => {
  renderProgress();
  syncReadAlongHighlight(false);
});
audio.addEventListener('loadedmetadata', () => {
  renderProgress();
  syncReadAlongHighlight(false);
});
seekEl.addEventListener('input', () => {
  if (!player) return;
  const { duration } = player.progress();
  if (duration > 0) {
    audio.currentTime = (Number(seekEl.value) / 1000) * duration;
    renderProgress();
    syncReadAlongHighlight(false);
  }
});
seekEl.addEventListener('change', () => {
  if (!restoringPosition) saveCurrentProgress({ syncServer: true });
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveCurrentProgress({ beacon: true });
});
window.addEventListener('pagehide', () => {
  saveCurrentProgress({ beacon: true });
});

loadLibrary().catch((error) => setMessage(error.message));
