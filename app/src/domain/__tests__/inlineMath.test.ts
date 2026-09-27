import { describe, expect, it } from 'vitest';

import { mathRanges, maskInlineMath, unmaskInlineMath } from '../inlineMath';
import { buildParagraphs, groupIntoLines } from '../paragraphBuilder';
import { isMathChar } from '../formulas';
import type { TextItem, TextSpan } from '../../types';

function span(start: number, end: number, extra: Partial<TextSpan> = {}): TextSpan {
  return { start, end, bold: false, italic: false, ...extra };
}

describe('mathRanges', () => {
  it('按出现顺序取出行内公式区间', () => {
    const text = 'where f(x) = y and g = z';
    const spans = [span(6, 14, { math: true }), span(19, 24, { math: true })];
    const ranges = mathRanges(text, spans);
    expect(ranges).toHaveLength(2);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe('f(x) = y');
    expect(text.slice(ranges[1].start, ranges[1].end)).toBe('g = z');
  });

  it('重叠区间合并 —— 避免重复占位导致回填错乱', () => {
    const text = 'abcdef';
    const spans = [span(0, 4, { math: true }), span(2, 6, { math: true })];
    const ranges = mathRanges(text, spans);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ start: 0, end: 6 });
  });

  it('非公式片段不参与', () => {
    const text = 'plain text';
    expect(mathRanges(text, [span(0, 5)])).toHaveLength(0);
  });
});

describe('maskInlineMath / unmaskInlineMath', () => {
  it('公式被替换成占位符，正文保留', () => {
    const text = 'where f(x) = y and so on';
    const spans = [span(6, 14, { math: true })];
    const { masked, pieces } = maskInlineMath(text, spans);
    expect(masked).toBe('where [[MATH_0]] and so on');
    expect(pieces).toHaveLength(1);
    expect(pieces[0].text).toBe('f(x) = y');
  });

  it('原文不含公式时原样返回（不影响缓存与既有行为）', () => {
    const text = 'a normal paragraph';
    const { masked, pieces } = maskInlineMath(text, [span(0, 2)]);
    expect(masked).toBe(text);
    expect(pieces).toHaveLength(0);
    expect(unmaskInlineMath('一段译文', pieces).text).toBe('一段译文');
  });

  it('回填把占位符换回原公式', () => {
    const text = 'where f(x) = y and g = z';
    const spans = [span(6, 14, { math: true }), span(19, 24, { math: true })];
    const { pieces } = maskInlineMath(text, spans);
    const translated = '其中 [[MATH_0]] 且 [[MATH_1]]';
    const { text: out, missing } = unmaskInlineMath(translated, pieces);
    expect(out).toBe('其中 f(x) = y 且 g = z');
    expect(missing).toBe(0);
  });

  it('模型丢了占位符：跳过该片段并计数告警，不整段判失败', () => {
    const text = 'where f(x) = y end';
    const spans = [span(6, 14, { math: true })];
    const { pieces } = maskInlineMath(text, spans);
    const { text: out, missing } = unmaskInlineMath('其中（公式被模型丢掉了）', pieces);
    expect(out).toBe('其中（公式被模型丢掉了）');
    expect(missing).toBe(1);
  });

  it('相同公式出现两次各自占位（不用文本回找偏移）', () => {
    const text = 'x and x';
    const spans = [span(0, 1, { math: true }), span(6, 7, { math: true })];
    const { masked, pieces } = maskInlineMath(text, spans);
    expect(pieces).toHaveLength(2);
    expect(masked).toBe('[[MATH_0]] and [[MATH_1]]');
    // 回填后原文复原
    const { text: out } = unmaskInlineMath(masked, pieces);
    expect(out).toBe(text);
  });
});

// ── 行内公式的识别（paragraphBuilder 侧）──
let seq = 0;
function item(str: string, fontName: string, fontSize = 12, baselineY = 100): TextItem {
  seq += 1;
  return {
    id: `i${seq}`,
    str,
    bbox: { x: seq * 20, y: 90, width: str.length * 6, height: fontSize },
    baselineY,
    fontSize,
    fontName,
    fontFamily: 'serif',
    bold: false,
    italic: false,
    rotated: false,
    columnIndex: 0,
  };
}

function paragraphOf(items: TextItem[]) {
  const lines = groupIntoLines(items);
  return buildParagraphs(lines, 0);
}

describe('行内公式识别', () => {
  it('数学字体（含子集化前缀）的文字项被标为公式', () => {
    const items = [
      item('We', 'NimbusRomNo9L-Medi'),
      item('use', 'NimbusRomNo9L-Medi'),
      item('f(x)', 'ABCDEF+CMMI12'),
      item('here', 'NimbusRomNo9L-Medi'),
    ];
    const blocks = paragraphOf(items);
    const spans = blocks[0].spans.filter((s) => s.math);
    expect(spans).toHaveLength(1);
    expect(blocks[0].text.slice(spans[0].start, spans[0].end)).toBe('f(x)');
  });

  it('上下标项被标为公式（下标是独立文本项）', () => {
    const items = [item('W', 'NimbusRomNo9L-Medi'), item('i', 'NimbusRomNo9L-Regu', 8, 103)];
    const blocks = paragraphOf(items);
    const mathSpans = blocks[0].spans.filter((s) => s.math);
    expect(mathSpans.length).toBeGreaterThanOrEqual(1);
    // 下标本体的 script 仍然是 sub
    expect(blocks[0].spans.some((s) => s.script === 'sub')).toBe(true);
  });

  it('纯正文（非数学字体、无符号）不产生公式片段', () => {
    const items = [
      item('The', 'NimbusRomNo9L-Regu'),
      item('network', 'NimbusRomNo9L-Regu'),
      item('degrades', 'NimbusRomNo9L-Regu'),
    ];
    const blocks = paragraphOf(items);
    expect(blocks[0].spans.filter((s) => s.math)).toHaveLength(0);
  });

  it('isMathChar 覆盖希腊字母与常用运算符（判据复用 formulas.ts）', () => {
    expect(isMathChar('α')).toBe(true);
    expect(isMathChar('∑')).toBe(true);
    expect(isMathChar('∈')).toBe(true);
    expect(isMathChar('a')).toBe(false);
  });
});
