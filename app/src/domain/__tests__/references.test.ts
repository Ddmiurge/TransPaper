import { describe, expect, it } from 'vitest';

import { isReferenceHeading, markReferences } from '../references';
import type { Block } from '../../types';

/** 造一个块。只填判定用得上的字段，其余给中性默认值 */
function block(
  id: string,
  text: string,
  overrides: Partial<Block> = {}
): Block {
  return {
    id,
    pageIndex: 0,
    columnIndex: 0,
    readOrder: 0,
    bbox: { x: 0, y: 0, width: 300, height: 20 },
    lineIds: [],
    text,
    spans: [],
    fontSize: 15,
    fontScale: 1,
    bold: false,
    headingLevel: 0,
    isBodyText: true,
    translatable: true,
    nonTranslatableReason: null,
    formula: false,
    widthRatio: 1,
    gapsPerLine: 0,
    figureReason: null,
    ...overrides,
  };
}

const heading = (id: string, text: string) =>
  block(id, text, { fontScale: 1.5, headingLevel: 2, bold: true });

const entry = (id: string, n: number) =>
  block(id, `[${n}] A. Author, B. Author. Some paper title. In Proc, 2016.`);

describe('参考文献标题识别', () => {
  it('识别英文与中文标题', () => {
    expect(isReferenceHeading(heading('h', 'References'))).toBe(true);
    expect(isReferenceHeading(heading('h', 'REFERENCES'))).toBe(true);
    expect(isReferenceHeading(heading('h', 'Bibliography'))).toBe(true);
    expect(isReferenceHeading(heading('h', '参考文献'))).toBe(true);
  });

  it('正文里出现的 references 一词不触发 —— 必须整块恰好等于标题', () => {
    // 正文句子 `...see references for details...` 若触发，会把整页后半段吞掉
    expect(isReferenceHeading(block('b', 'see references for details'))).toBe(false);
    expect(isReferenceHeading(block('b', 'References [1] Y. Bengio'))).toBe(false);
  });

  it('字号与正文一致的 `References` 不算标题 —— 可能是正文里的独立行', () => {
    expect(isReferenceHeading(block('b', 'References'))).toBe(false);
  });
});

describe('文献区间标记', () => {
  it('从标题起、到末尾的条目全部标记为不翻译', () => {
    const blocks = [
      block('p1', 'Some body paragraph before the references.'),
      heading('h', 'References'),
      entry('r1', 1),
      entry('r2', 2),
      entry('r3', 3),
    ];

    const active = markReferences(blocks, false);

    expect(blocks[0].translatable).toBe(true);
    // 标题本身可译：它是章节名（References → 参考文献），不是文献条目
    expect(blocks[1].translatable).toBe(true);
    for (const b of blocks.slice(2)) {
      expect(b.translatable).toBe(false);
      expect(b.nonTranslatableReason).toBe('references');
    }
    expect(active).toBe(true);
  });

  it('遇到文献之后的真标题就退出 —— 否则附录会被整段吞掉', () => {
    // 真实场景：文献在第 9 页列末开始，第 10 页是附录 `A. Object Detection Baselines`。
    // 没有这条退出判断，附录会完全不翻译。
    const blocks = [
      heading('h', 'References'),
      entry('r1', 1),
      entry('r2', 2),
      heading('appendix', 'A. Object Detection Baselines'),
      block('ap1', 'In this section we introduce our detection method.'),
    ];

    const active = markReferences(blocks, false);

    expect(blocks[1].translatable).toBe(false);
    expect(blocks[2].translatable).toBe(false);
    // 附录标题与正文恢复可译
    expect(blocks[3].translatable).toBe(true);
    expect(blocks[4].translatable).toBe(true);
    expect(active).toBe(false);
  });

  it('不把 `[12]` 开头的标题误判为退出信号', () => {
    // 有些排版会把条目首行识别成标题（字号略大），此时不能退出区间
    const blocks = [
      heading('h', 'References'),
      block('r1', '[1] A. Author. Title.', { headingLevel: 1, fontScale: 1.1 }),
      block('r2', '[2] B. Author. Title.'),
    ];

    markReferences(blocks, false);
    expect(blocks[1].translatable).toBe(false);
  });

  it('入状态为真时，本页无需标题也可继续标记（跨页延续）', () => {
    const blocks = [entry('r1', 30), entry('r2', 31)];
    const active = markReferences(blocks, true);

    expect(blocks.every((b) => !b.translatable)).toBe(true);
    expect(active).toBe(true);
  });

  it('没有文献标题也不在区间内时，全部保持可译', () => {
    const blocks = [block('p1', 'First paragraph.'), block('p2', 'Second paragraph.')];
    const active = markReferences(blocks, false);

    expect(blocks.every((b) => b.translatable)).toBe(true);
    expect(active).toBe(false);
  });

  it('跨页串联：第 9 页进入、第 10 页延续、第 11 页退出', () => {
    // 这是最能说明「为什么状态要逐页传递」的场景
    const p9 = [heading('h', 'References'), entry('a', 1), entry('b', 2)];
    const p10 = [entry('c', 3), entry('d', 4)];
    const p11 = [block('tail', 'Last paragraph of the paper.')];

    const after9 = markReferences(p9, false);
    const after10 = markReferences(p10, after9);
    const after11 = markReferences(p11, after10);

    expect(after9).toBe(true);
    expect(after10).toBe(true);
    // 第 11 页没有标题、也没有条目 —— 但它仍处于区间内，所以被标记为不翻译。
    // 这是**保守**的选择：宁可多标一段，也不要让文献泄漏出去被翻译。
    // 真实论文在文献之后一定有新标题（附录、致谢），那时会自动退出。
    expect(after11).toBe(true);
    expect(p11[0].translatable).toBe(false);
  });
});
