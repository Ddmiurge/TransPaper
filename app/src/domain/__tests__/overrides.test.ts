import { describe, expect, it } from 'vitest';

import {
  anchorOf,
  applyOverride,
  applyOverrides,
  AutoJudgmentStash,
  type AutoJudgmentStash as Stash,
} from '../overrides';
import type { Block } from '../../types';

function block(id: string, text: string, pageIndex = 0, overrides: Partial<Block> = {}): Block {
  return {
    id,
    pageIndex,
    columnIndex: 0,
    readOrder: 0,
    bbox: { x: 0, y: 0, width: 300, height: 20 },
    lineIds: ['l0'],
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

describe('anchorOf', () => {
  it('锚点由页码 + 归一化文本前缀构成，空白折叠', () => {
    const a = anchorOf(block('b0', 'The  results   are\ncompared  (1).'));
    const b = anchorOf(block('b0', 'The results are compared (1).'));
    expect(a).toBe(b);
    expect(a.startsWith('0|')).toBe(true);
  });

  it('不同页的相同文本锚点不同（页码参与）', () => {
    expect(anchorOf(block('b0', 'Same text', 0))).not.toBe(anchorOf(block('b1', 'Same text', 1)));
  });

  it('锚点不包含块 id —— 序号位移不影响命中', () => {
    expect(anchorOf(block('b0', 'Same text'))).toBe(anchorOf(block('b7', 'Same text')));
  });
});

describe('applyOverrides', () => {
  it('figure 改判移出正文流，body 改判恢复正文并翻译', () => {
    const stash = new AutoJudgmentStash();
    const b = block('b0', 'A figure region block');
    applyOverrides([b], new Map([[anchorOf(b), 'figure']]), stash);
    expect(b.isBodyText).toBe(false);
    expect(b.figureReason).toBe('graphics-region');
    expect(b.translatable).toBe(false);

    // 改回 body：从自动值出发恢复为可译正文
    applyOverrides([b], new Map([[anchorOf(b), 'body']]), stash);
    expect(b.isBodyText).toBe(true);
    expect(b.translatable).toBe(true);
    expect(b.figureReason).toBeNull();
  });

  it('撤销最后一条改判（auto / 空表）后恢复自动判定 —— 幂等', () => {
    const stash = new AutoJudgmentStash();
    const b = block('b0', 'Some paragraph', 0, { isBodyText: false, figureReason: 'font-size' });
    // 自动值：图内文字（不可译）
    applyOverrides([b], new Map([[anchorOf(b), 'body']]), stash);
    expect(b.isBodyText).toBe(true);

    // byAnchor 清空（撤销）→ 必须回到自动值，而不是停留在改判值
    applyOverrides([b], new Map(), stash);
    expect(b.isBodyText).toBe(false);
    expect(b.figureReason).toBe('font-size');
  });

  it('formula 改判保留正文流身份、以切片输出；reference 保留文本但免译', () => {
    const stash = new AutoJudgmentStash();
    const f = block('f0', 'y = F(x) + x (1)');
    applyOverrides([f], new Map([[anchorOf(f), 'formula']]), stash);
    expect(f.formula).toBe(true);
    expect(f.translatable).toBe(false);
    expect(f.isBodyText).toBe(true); // 公式走 scaleToText 切片，仍属正文流

    const r = block('r0', '[1] A. Author. Some title.');
    applyOverrides([r], new Map([[anchorOf(r), 'reference']]), stash);
    expect(r.isBodyText).toBe(true);
    expect(r.translatable).toBe(false);
    expect(r.nonTranslatableReason).toBe('references');
  });

  it('重复套用同一改判是幂等的', () => {
    const stash = new AutoJudgmentStash();
    const b = block('b0', 'A table row');
    const overrides = new Map([[anchorOf(b), 'table' as const]]);
    applyOverrides([b], overrides, stash);
    const snap = JSON.stringify(b);
    applyOverrides([b], overrides, stash);
    applyOverrides([b], overrides, stash);
    expect(JSON.stringify(b)).toBe(snap);
  });

  it('锚点未命中的块不受影响', () => {
    const stash = new AutoJudgmentStash();
    const b = block('b0', 'Normal paragraph');
    applyOverrides([b], new Map([['9|not-this-block', 'figure']]), stash);
    expect(b.isBodyText).toBe(true);
    expect(b.translatable).toBe(true);
  });
});

describe('applyOverride', () => {
  it('auto 不做任何事（撤销由 restore 负责）', () => {
    const b = block('b0', 'text', 0, { isBodyText: false });
    applyOverride(b, 'auto');
    expect(b.isBodyText).toBe(false);
  });
});

// 类型冒烟：Stash 与 AutoJudgmentStash 是同一类型
type _Same = Stash extends AutoJudgmentStash ? true : false;
