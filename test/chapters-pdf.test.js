import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { splitPlainText } from '../src/chapters.js';
import { unwrapPdfLines } from '../src/extract.js';
import { splitParagraphs } from '../src/paragraphs.js';

describe('pdf chapter headings', () => {
  test('keeps a spaced chinese heading on the existing rule', () => {
    const chapters = splitPlainText('前言\n第一章 甲\n甲的正文\n第二章 乙\n乙的正文\n', '书');
    assert.equal(chapters.length, 2);
    assert.equal(chapters[0].title, '第一章 甲');
    assert.match(chapters[0].text, /甲的正文/);
  });

  test('splits a pdfjs book into the real chapters and a preface', () => {
    const lines = [
      '深入理解 AI Infra',
      '量化分析与系统设计',
      '这是一段足够长的前言，用来确认页眉式章节标题出现之前的正文不会被丢掉，也不会被目录里的同名标题切碎。',
      '第 1 章 初识 AI Infra 1',
      '1.1 为什么重要',
      '第 2 章 模型架构 23',
      '2.1 计算图',
      'IX 第 1 章 初识 AI Infra',
      '本章起沿着模型的执行过程，认识支撑这一过程的系统。',
      '第 2 章展开，训练与推理负载在第 3 章展开。',
      '第 7 章',
      '22 第 2 章 模型架构',
      '模型的计算、参数和上下文状态如何形成资源需求。',
    ];
    const chapters = splitPlainText(lines.join('\n'), 'AI-Infra-Book');
    assert.deepEqual(chapters.map((chapter) => chapter.title), [
      '前言',
      '第1章 初识 AI Infra',
      '第2章 模型架构',
    ]);
    assert.match(chapters[0].text, /足够长的前言/);
    assert.equal(chapters[0].text.includes('1.1 为什么重要'), true);
    assert.match(chapters[1].text, /本章起沿着模型的执行过程/);
    assert.match(chapters[1].text, /第 2 章展开/);
    assert.match(chapters[2].text, /上下文状态如何形成资源需求/);
    assert.equal(chapters.some((chapter) => chapter.title === '第7章'), false);
  });

  test('joins wrapped pdf lines into a sentence and keeps the heading', () => {
    const raw = [
      'IX 第 1 章 初识 AI Infra',
      '前言介绍了本书的写作缘起。本章起沿着模型的执行',
      '过程，认识支撑这一过程的系统。',
      'AI Infra 是支撑训练和推理的基础设施。',
      '22 第 2 章 模型架构',
      '参数和上下文状态如何形成资源需求。',
    ].join('\n');
    const unwrapped = unwrapPdfLines(raw);
    const chapters = splitPlainText(unwrapped, '书');
    assert.deepEqual(chapters.map((chapter) => chapter.title), [
      '第1章 初识 AI Infra',
      '第2章 模型架构',
    ]);
    const packed = splitParagraphs(chapters[0].text);
    assert.equal(packed.length, 1);
    assert.match(packed[0], /写作缘起。本章起沿着模型的执行过程/);
    assert.match(packed[0], /训练和推理的基础设施。/);
    const longSentence = `${'甲'.repeat(250)}。`;
    const over = unwrapPdfLines(`${longSentence}\n${'乙'.repeat(50)}\n${'乙'.repeat(50)}。`);
    assert.deepEqual(splitParagraphs(over), [longSentence, `${'乙'.repeat(100)}。`]);
  });
});
