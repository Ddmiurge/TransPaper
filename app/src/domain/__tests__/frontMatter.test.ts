import { describe, expect, it } from 'vitest';

import { findFrontMatterBoundary, findTitleBlock, markFrontMatter } from '../frontMatter';
import type { Block } from '../../types';

/** 造一个块。只填判定用得上的字段，其余给中性默认值 */
function block(id: string, text: string, overrides: Partial<Block> = {}): Block {
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

/** 用 y 直接定位到 bbox，避免把 y 误放到顶层字段 */
function at(y: number, extra: Partial<Block> = {}): Partial<Block> {
  return { bbox: { x: 0, y, width: 300, height: 20 }, ...extra };
}

const pageHeight = 1200;

describe('findTitleBlock', () => {
  it('取前 40% 页高内字号最大的块', () => {
    const blocks = [
      block('title', 'Deep Residual Learning', at(150, { fontScale: 1.44, widthRatio: 1.1 })),
      block('author', 'Kaiming He', at(220, { fontScale: 1.2 })),
      block('abstract', 'Abstract', at(334, { fontScale: 1.2 })),
      block('intro', '1. Introduction', at(800, { fontScale: 1.2 })),
    ];
    expect(findTitleBlock(blocks, pageHeight)?.id).toBe('title');
  });

  it('忽略前 40% 之外的块（避免把章节大标题误当论文标题）', () => {
    const blocks = [
      block('title', 'Deep Residual Learning', at(150, { fontScale: 1.44 })),
      block('lateHeading', '3. Experiments', at(600, { fontScale: 1.4 })),
    ];
    expect(findTitleBlock(blocks, pageHeight)?.id).toBe('title');
  });

  it('没有足够大的字时返回 null（保守不误伤）', () => {
    const blocks = [block('a', 'Kaiming He', at(220, { fontScale: 1.1 }))];
    expect(findTitleBlock(blocks, pageHeight)).toBeNull();
  });
});

describe('findFrontMatterBoundary', () => {
  it('优先匹配 Abstract / 摘要 标题词', () => {
    const blocks = [
      block('title', 'Title', at(150, { fontScale: 1.44 })),
      block('author', 'Kaiming He', at(220)),
      block('abstract', 'Abstract', at(334, { fontScale: 1.2 })),
      block('body', 'Deeper neural networks are more difficult to train.', at(366, { widthRatio: 1 })),
    ];
    expect(findFrontMatterBoundary(blocks, 150)).toBe(334);
  });

  it('没有 Abstract 词时用首个宽正文段兜底', () => {
    const blocks = [
      block('title', 'Title', at(150, { fontScale: 1.44 })),
      block('author', 'Kaiming He', at(220, { widthRatio: 0.6 })),
      block('intro', '1. Introduction', at(300, { widthRatio: 0.3 })),
      block('body', 'Deep convolutional neural networks have led to a series of breakthroughs for image classification.', at(360, { fontScale: 1, widthRatio: 1 })),
    ];
    // 摘要/引言标题是窄的短标题，不应触发兜底；真正的宽正文段才触发
    expect(findFrontMatterBoundary(blocks, 150)).toBe(360);
  });

  it('什么都找不到返回 Infinity', () => {
    const blocks = [block('title', 'Title', at(150, { fontScale: 1.44 }))];
    expect(findFrontMatterBoundary(blocks, 150)).toBe(Infinity);
  });
});

describe('markFrontMatter', () => {
  it('标题与摘要之间的块标记为 authors，标题与摘要本身保持可译', () => {
    const blocks = [
      block('title', 'Deep Residual Learning', at(150, { fontScale: 1.44, widthRatio: 1.1 })),
      block('author1', 'Kaiming He Xiangyu Zhang', at(220, { fontScale: 1.2, widthRatio: 0.68 })),
      block('email', '{kahe, v-xiangz, v-shren, jiansun', at(274, { widthRatio: 0.56 })),
      block('author2', 'Shaoqing Ren Jian Sun', at(224, { fontScale: 1.2, widthRatio: 0.54 })),
      block('affil', 'Microsoft Research', at(249, { widthRatio: 0.6 })),
      block('abstract', 'Abstract', at(334, { fontScale: 1.2 })),
      block('body', 'Deeper neural networks are more difficult to train.', at(366, { widthRatio: 1 })),
    ];
    markFrontMatter(blocks, pageHeight);

    expect(blocks.find((b) => b.id === 'title')?.translatable).toBe(true);
    expect(blocks.find((b) => b.id === 'abstract')?.translatable).toBe(true);
    for (const id of ['author1', 'email', 'author2', 'affil']) {
      const b = blocks.find((x) => x.id === id)!;
      expect(b.translatable).toBe(false);
      expect(b.nonTranslatableReason).toBe('authors');
    }
    expect(blocks.find((b) => b.id === 'body')?.translatable).toBe(true);
  });

  it('非首页（pageIndex !== 0）不做任何修改', () => {
    const blocks = [
      { ...block('a', 'Kaiming He', at(220)), pageIndex: 1 },
      { ...block('b', 'Some body text on page 2', at(400, { widthRatio: 1 })), pageIndex: 1 },
    ];
    markFrontMatter(blocks, pageHeight);
    expect(blocks.every((b) => b.translatable)).toBe(true);
    expect(blocks.every((b) => b.nonTranslatableReason === null)).toBe(true);
  });

  it('没有标题时整体不误伤', () => {
    const blocks = [
      block('author', 'Kaiming He', at(220, { fontScale: 1.1 })),
      block('body', 'Deeper neural networks are more difficult to train.', at(366, { widthRatio: 1 })),
    ];
    markFrontMatter(blocks, pageHeight);
    expect(blocks.every((b) => b.translatable)).toBe(true);
  });

  it('摘要标题位于边界 y 上、不应被误判（下界严格小于边界）', () => {
    const blocks = [
      block('title', 'Title', at(150, { fontScale: 1.44 })),
      block('abstract', 'ABSTRACT Agentic LLMs are vulnerable to attacks of many kinds and forms.', at(318, { widthRatio: 0.82 })),
      block('body', 'Agentic LLMs are increasingly deployed to act on behalf of users.', at(360, { widthRatio: 1 })),
    ];
    markFrontMatter(blocks, pageHeight);
    expect(blocks.find((b) => b.id === 'abstract')?.translatable).toBe(true);
    expect(blocks.find((b) => b.id === 'body')?.translatable).toBe(true);
  });
});
