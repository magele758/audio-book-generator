import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { splitParagraphs } from '../src/paragraphs.js';

describe('splitParagraphs', () => {
  test('returns an empty list for empty input', () => {
    assert.deepEqual(splitParagraphs(''), []);
    assert.deepEqual(splitParagraphs('  \r\n\t'), []);
  });

  test('keeps a short chapter as one element', () => {
    const chapter = '第一章只有一段。\n它没有空行。';
    assert.deepEqual(splitParagraphs(chapter), [chapter]);
    const exact = '字'.repeat(320);
    assert.deepEqual(splitParagraphs(exact), [exact]);
  });

  test('splits on blank lines', () => {
    const text = '第一段。\r\n\r\n第二段！\n\n\n第三段？';
    assert.deepEqual(splitParagraphs(text), ['第一段。', '第二段！', '第三段？']);
  });

  test('splits a long block into sentences', () => {
    const sentences = [
      `${'甲'.repeat(100)}。`,
      `${'乙'.repeat(100)}！`,
      `${'丙'.repeat(100)}？`,
      `${'D'.repeat(100)}!`,
      `${'E'.repeat(100)}?`,
      `${'己'.repeat(100)}；`,
      `${'G'.repeat(100)};`,
      '行'.repeat(200),
      '行'.repeat(200),
    ];
    const text = `${sentences.slice(0, 7).join('')}\n${sentences[7]}\n${sentences[8]}`;
    assert.deepEqual(splitParagraphs(text), sentences);
  });

  test('splits an overlong sentence on commas', () => {
    const text = `${'甲'.repeat(20)}，${'乙'.repeat(20)},${'丙'.repeat(20)}。`;
    assert.deepEqual(splitParagraphs(text, { maxChars: 30 }), [
      `${'甲'.repeat(20)}，`,
      `${'乙'.repeat(20)},`,
      `${'丙'.repeat(20)}。`,
    ]);
  });

  test('hard-cuts a 600-character run with no punctuation', () => {
    const run = '字'.repeat(600);
    assert.deepEqual(splitParagraphs(run), ['字'.repeat(320), '字'.repeat(280)]);
  });

  test('clamps maxChars above 500', () => {
    const run = '字'.repeat(600);
    assert.deepEqual(splitParagraphs(run, { maxChars: 900 }), ['字'.repeat(500), '字'.repeat(100)]);
  });

  test('does not cut a surrogate pair in half', () => {
    const pair = '😀';
    assert.deepEqual(splitParagraphs(`${pair}${'a'.repeat(5)}`, { maxChars: 1 }), [
      pair, 'a', 'a', 'a', 'a', 'a',
    ]);
    assert.deepEqual(splitParagraphs(`ab${pair}cd`, { maxChars: 3 }), ['ab', `${pair}c`, 'd']);
  });
});
