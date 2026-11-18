// Index-TTS rejects text longer than 500 characters.
const INDEX_TTS_LIMIT = 500;
const DEFAULT_MAX_CHARS = 320;

const SENTENCE_ENDINGS = new Set(['。', '！', '？', '!', '?', '；', ';', '\n']);
const COMMAS = new Set(['，', ',']);

export function splitParagraphs(text, options = {}) {
  const maxChars = clampMaxChars(options?.maxChars);
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const pieces = [];
  for (const block of splitBlocks(normalized)) {
    for (const piece of divideBlock(block, maxChars)) {
      if (piece) pieces.push(piece);
    }
  }
  return pieces;
}

function clampMaxChars(value) {
  const number = Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_CHARS;
  if (number < 1) return 1;
  if (number > INDEX_TTS_LIMIT) return INDEX_TTS_LIMIT;
  return number;
}

function splitBlocks(text) {
  const blocks = [];
  let lines = [];
  const flush = () => {
    if (!lines.length) return;
    const block = lines.join('\n').trim();
    if (block) blocks.push(block);
    lines = [];
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '') flush();
    else lines.push(line);
  }
  flush();
  return blocks;
}

function divideBlock(block, maxChars) {
  if (block.length <= maxChars) return [block];
  const pieces = [];
  for (const sentence of splitOn(block, SENTENCE_ENDINGS)) {
    if (sentence.length <= maxChars) {
      pieces.push(sentence);
      continue;
    }
    for (const clause of splitOn(sentence, COMMAS)) {
      if (clause.length <= maxChars) pieces.push(clause);
      else pieces.push(...cutUnits(clause, maxChars));
    }
  }
  return pieces;
}

function splitOn(text, delimiters) {
  const parts = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!delimiters.has(text[index])) continue;
    const piece = text.slice(start, index + 1).trim();
    if (piece) parts.push(piece);
    start = index + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function cutUnits(text, maxChars) {
  const parts = [];
  let index = 0;
  while (index < text.length) {
    let end = Math.min(index + maxChars, text.length);
    const splitsPair = end < text.length
      && isHighSurrogate(text.charCodeAt(end - 1))
      && isLowSurrogate(text.charCodeAt(end));
    if (splitsPair) end -= 1;
    // maxChars landed inside a surrogate pair, so keep that one character whole.
    if (end === index) end += 2;
    parts.push(text.slice(index, end));
    index = end;
  }
  return parts;
}

function isHighSurrogate(code) {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code) {
  return code >= 0xDC00 && code <= 0xDFFF;
}
