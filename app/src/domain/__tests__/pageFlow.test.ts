import { describe, expect, it } from 'vitest';

import { buildPageFlow, type FlowSlice, type FlowText } from '../pageFlow';
import type { Block, PageAnalysis } from '../../types';

const PAGE_HEIGHT = 1000;

function makeBlock(
  id: string,
  columnIndex: number,
  x: number,
  y: number,
  width: number,
  height: number,
  isBodyText = true
): Block {
  return {
    id,
    pageIndex: 0,
    columnIndex,
    readOrder: columnIndex * 10000 + Math.round(y),
    bbox: { x, y, width, height },
    lineIds: [],
    text: `text of ${id}`,
    spans: [{ start: 0, end: `text of ${id}`.length, bold: false, italic: false }],
    fontSize: 12,
    fontScale: 1,
    bold: false,
    headingLevel: 0,
    isBodyText,
    translatable: true,
    nonTranslatableReason: null,
    formula: false,
    widthRatio: 1,
    gapsPerLine: 0,
    figureReason: null,
  };
}

function makeAnalysis(blocks: Block[], boundaries: number[]): PageAnalysis {
  return {
    pageIndex: 0,
    width: boundaries[boundaries.length - 1],
    height: PAGE_HEIGHT,
    items: [],
    lines: [],
    blocks,
    segments: [],
    columnBoundaries: boundaries,
    columnSplits: boundaries.slice(1, -1),
    bodyFontSize: 12,
    bodyBlockCount: blocks.filter((b) => b.isBodyText).length,
    contentBounds: contentBoundsOf(blocks, boundaries),
    figureRegions: [],
    referencesActive: false,
  };
}

function contentBoundsOf(blocks: Block[], boundaries: number[]) {
  if (blocks.length === 0) return { x: 0, y: 0, width: boundaries[boundaries.length - 1], height: 0 };
  const left = Math.min(...blocks.map((b) => b.bbox.x));
  const right = Math.max(...blocks.map((b) => b.bbox.x + b.bbox.width));
  const top = Math.min(...blocks.map((b) => b.bbox.y));
  const bottom = Math.max(...blocks.map((b) => b.bbox.y + b.bbox.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function translationMap(blocks: Block[]): Map<string, string> {
  return new Map(blocks.filter((b) => b.isBodyText).map((b) => [b.id, `T(${b.id})`]));
}

const slicesOf = (flow: ReturnType<typeof buildPageFlow>, sourceX: number): FlowSlice[] =>
  flow.nodes.filter((n): n is FlowSlice => n.kind === 'slice' && n.source.x === sourceX);

const textsOf = (flow: ReturnType<typeof buildPageFlow>): FlowText[] =>
  flow.nodes.filter((n): n is FlowText => n.kind === 'text');

describe('buildPageFlow · 正文抽成文本', () => {
  it('正文段落输出为 text 节点，且原文与译文成对', () => {
    const blocks = [
      makeBlock('a1', 0, 50, 100, 400, 100),
      makeBlock('a2', 0, 50, 250, 400, 100),
    ];
    const flow = buildPageFlow(makeAnalysis(blocks, [0, 500, 1000]), translationMap(blocks));

    const texts = textsOf(flow);
    expect(texts).toHaveLength(2);
    expect(texts[0].source).toBe('text of a1');
    expect(texts[0].target).toBe('T(a1)');
    expect(texts[1].source).toBe('text of a2');
    expect(flow.stats.textCount).toBe(2);
    expect(flow.stats.translatedCount).toBe(2);
  });

  it('段落之间的空白会被切成图像片段（无 hasContent 时保留）', () => {
    const blocks = [
      makeBlock('a1', 0, 50, 100, 400, 100),
      makeBlock('a2', 0, 50, 250, 400, 100),
    ];
    const flow = buildPageFlow(makeAnalysis(blocks, [0, 500, 1000]), translationMap(blocks));

    const slices = slicesOf(flow, 0);
    expect(slices).toHaveLength(1);
    expect(slices[0].source.y).toBe(200);
    expect(slices[0].source.height).toBe(50);
  });

  it('hasContent 判定为空白的填充区被丢弃，段落间距交给 CSS', () => {
    const blocks = [
      makeBlock('a1', 0, 50, 100, 400, 100),
      makeBlock('a2', 0, 50, 250, 400, 100),
    ];
    const flow = buildPageFlow(makeAnalysis(blocks, [0, 500, 1000]), translationMap(blocks), {
      hasContent: () => false,
    });
    expect(flow.stats.sliceCount).toBe(0);
    expect(flow.stats.textCount).toBe(2);
  });

  it('isBodyText = false 的块不生成文本节点，而是并入图像区域', () => {
    const blocks = [
      makeBlock('fig', 0, 50, 100, 400, 200, false), // 图内标签
      makeBlock('a1', 0, 50, 350, 400, 100, true),
    ];
    const flow = buildPageFlow(makeAnalysis(blocks, [0, 500, 1000]), new Map([['a1', 'T']]));

    const texts = textsOf(flow);
    expect(texts).toHaveLength(1);
    expect(texts[0].blockId).toBe('a1');

    // 图内标签所在的 100–300 必须被图像覆盖，不能丢
    const slices = slicesOf(flow, 0).sort((a, b) => a.source.y - b.source.y);
    const covered = slices.reduce((sum, s) => sum + s.source.height, 0);
    // 图像覆盖 100 → 350（图内标签 200px + 到下一段的 50px 间隙），
    // 350 → 450 是正文段落，由 HTML 承担
    expect(covered).toBe(250);
    expect(slices[0].source.y).toBe(100);
  });

  it('标题携带层级与字号倍率，供 HTML 还原视觉层级', () => {
    const heading = makeBlock('h', 0, 50, 100, 200, 40);
    heading.headingLevel = 1;
    heading.fontScale = 1.2;
    heading.bold = true;
    const flow = buildPageFlow(makeAnalysis([heading], [0, 500, 1000]), new Map([['h', 'T']]));
    const text = textsOf(flow)[0];
    expect(text.headingLevel).toBe(1);
    expect(text.fontScale).toBe(1.2);
    expect(text.bold).toBe(true);
  });

  it('同一栏内图像切片连续且不重叠（关键不变量）', () => {
    const blocks = [
      makeBlock('f1', 0, 50, 100, 400, 120, false),
      makeBlock('a1', 0, 50, 260, 400, 80, true),
      makeBlock('f2', 0, 50, 380, 400, 120, false),
    ];
    const flow = buildPageFlow(makeAnalysis(blocks, [0, 500, 1000]), new Map([['a1', 'T']]));
    const slices = slicesOf(flow, 0).sort((a, b) => a.source.y - b.source.y);

    expect(slices.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < slices.length; i += 1) {
      const prevEnd = slices[i - 1].source.y + slices[i - 1].source.height;
      expect(slices[i].source.y).toBeGreaterThanOrEqual(prevEnd - 0.001);
    }
    // 图像覆盖 100→260 与 340→500，共 320px；
    // 260→340 是正文段落，由 HTML 承担，不在图像覆盖范围内
    const covered = slices.reduce((sum, s) => sum + s.source.height, 0);
    expect(covered).toBe(320);
  });

  it('跨栏元素只在归属栏输出一次，其他栏留下 skip 区间', () => {
    const blocks = [
      makeBlock('title', 0, 200, 50, 600, 40),
      makeBlock('a1', 0, 50, 120, 400, 100),
      makeBlock('b1', 1, 550, 120, 400, 100),
    ];
    const flow = buildPageFlow(makeAnalysis(blocks, [0, 500, 1000]), translationMap(blocks));

    expect(flow.stats.skippedIntervalCount).toBe(1);

    // 跨栏标题属于正文，重排后应成为整行宽的文本节点（不是宽图像切片）——
    // 这正是「重排」与「截图拼接」的区别
    const texts = textsOf(flow);
    const title = texts.find((t) => t.blockId === 'title');
    expect(title).toBeDefined();
    expect(title?.width).toBe(900); // 全页内容宽度（50 → 950）
  });

  it('无译文时仍输出原文文本节点', () => {
    const blocks = [makeBlock('a1', 0, 50, 100, 400, 100)];
    const flow = buildPageFlow(makeAnalysis(blocks, [0, 500, 1000]), new Map());
    const texts = textsOf(flow);
    expect(texts).toHaveLength(1);
    expect(texts[0].target).toBeNull();
    expect(flow.stats.translatedCount).toBe(0);
  });

  it('空页面不崩，产出空流', () => {
    const flow = buildPageFlow(makeAnalysis([], [0, 500, 1000]), new Map());
    expect(flow.nodes).toHaveLength(0);
    expect(flow.stats.textCount).toBe(0);
  });
});

describe('跨栏图形（横跨栏缝的图 / 通栏表格）', () => {
  /** 两栏版式：栏缝在 x=400，另有左右两栏的正文 */
  function twoColumnPage() {
    const left = makeBlock('L', 0, 50, 100, 300, 20);
    const right = makeBlock('R', 1, 450, 100, 300, 20);
    return makeAnalysis([left, right], [0, 400, 800]);
  }

  it('跨栏图形输出为一片，而不是被栏缝劈成两半', () => {
    // 翻车现场：裁切是按栏做的，横跨栏缝的图会被切成 x=0→400 与 x=400→800 两片；
    // 而文档流是「左栏全部输出完再输出右栏」，两半因此相隔很远。
    const span = [{ x: 100, y: 500, width: 600, height: 120 }];
    const flow = buildPageFlow(twoColumnPage(), new Map(), {
      hasContent: () => true,
      figureRegions: span,
    });

    const slices = flow.nodes.filter((n): n is FlowSlice => n.kind === 'slice');
    // 裁切范围取自图形自身（这里没传 figurePaths，退回用簇的包围盒）。
    // 不能用整幅版心 —— 那会把别的栏的正文一起切进来。
    const crossing = slices.filter((n) => n.source.width > 400);
    expect(crossing).toHaveLength(1);
    expect(crossing[0].source.x).toBe(100);
    expect(crossing[0].source.width).toBe(600);
    expect(crossing[0].source.y).toBe(500);
    // 且只输出一次（不会在两栏里各来一遍）
    expect(slices.filter((n) => n.source.y === 500)).toHaveLength(1);
  });

  it('不传跨栏图形时不产生额外切片，行为与以前一致', () => {
    const span = [{ x: 100, y: 500, width: 600, height: 120 }];
    const flow = buildPageFlow(twoColumnPage(), new Map(), {
      hasContent: () => true,
    });
    const slices = flow.nodes.filter((n): n is FlowSlice => n.kind === 'slice');
    expect(slices.some((n) => n.source.width > 400)).toBe(false);
    void span;
  });

  it('只覆盖单栏的图形区域不当作跨栏处理', () => {
    const flow = buildPageFlow(twoColumnPage(), new Map(), {
      hasContent: () => true,
      figureRegions: [{ x: 50, y: 500, width: 300, height: 120 }],
    });
    const slices = flow.nodes.filter((n): n is FlowSlice => n.kind === 'slice');
    expect(slices.some((n) => n.source.width > 400)).toBe(false);
  });
});


describe('空隙切片：只有真的含图形才保留', () => {
  /** 单栏，两个正文块中间留一段纵向空隙 */
  function twoBlocksWithGap() {
    const a = makeBlock('A', 0, 50, 100, 300, 40);
    const b = makeBlock('B', 0, 50, 300, 300, 40);
    return makeAnalysis([a, b], [0, 800]);
  }

  const slicesOfFlow = (flow: ReturnType<typeof buildPageFlow>) =>
    flow.nodes.filter((n): n is FlowSlice => n.kind === 'slice');

  it('空隙里没有图形 → 丢弃，把留白交给 CSS', () => {
    // 旧实现对每个空隙都无条件切图，于是段落之间的留白全变成纯白色图像节点。
    // 实测第 1 页 9 个切片里 7 个是全白的 —— 页面上因此出现莫名的大段空白，
    // 「正文段间距交给 CSS」这个设计意图完全落空。
    const blocks = twoBlocksWithGap().blocks;
    const flow = buildPageFlow(twoBlocksWithGap(), translationMap(blocks), { figurePaths: [] });

    expect(slicesOfFlow(flow)).toHaveLength(0);
    // 空隙 140 → 300 被省掉
    expect(flow.stats.droppedGapHeight).toBe(160);
  });

  it('空隙里真的有图形 → 保留为切片', () => {
    const flow = buildPageFlow(twoBlocksWithGap(), translationMap(twoBlocksWithGap().blocks), {
      figurePaths: [{ x: 60, y: 200, width: 120, height: 60 }],
    });

    const slices = slicesOfFlow(flow);
    expect(slices).toHaveLength(1);
    expect(slices[0].source.y).toBe(140);
    expect(slices[0].source.height).toBe(160);
    expect(flow.stats.droppedGapHeight).toBe(0);
  });

  it('未提供 figurePaths 时退回「一律切图」的降级行为', () => {
    // 解析信息缺失（拿不到矢量路径）时宁可多切，也不能把图丢了。
    // 这条是向后兼容的保险丝。
    const flow = buildPageFlow(twoBlocksWithGap(), translationMap(twoBlocksWithGap().blocks), {
      hasContent: () => true,
    });
    expect(slicesOfFlow(flow)).toHaveLength(1);
  });

  it('判据必须同时看 x：另一栏有图形，不该把本栏的空隙也切出来', () => {
    // 只看 y 就会把两栏的空隙都当成「含图形」，左栏于是多出一块空白切片。
    const leftTop = makeBlock('LT', 0, 50, 100, 300, 40);
    const leftBottom = makeBlock('LB', 0, 50, 300, 300, 40);
    const rightTop = makeBlock('RT', 1, 450, 100, 300, 40);
    const rightBottom = makeBlock('RB', 1, 450, 300, 300, 40);
    const analysis = makeAnalysis([leftTop, leftBottom, rightTop, rightBottom], [0, 400, 800]);

    const flow = buildPageFlow(analysis, translationMap(analysis.blocks), {
      // 图形只在右栏
      figurePaths: [{ x: 450, y: 200, width: 300, height: 60 }],
    });

    const slices = slicesOfFlow(flow);
    expect(slices).toHaveLength(1);
    expect(slices[0].source.x).toBe(400); // 右栏的左边
  });
});

describe('跨栏裁切范围：不该外溢到别的栏', () => {
  it('图形只是略微越过栏缝时，裁切范围不扩到整幅版心', () => {
    // 实测第 4 页：架构图 x 111→427，栏缝在 414 —— 只超出 13px 就被当成跨栏元素，
    // 裁切范围被扩到「整幅版心」（75→818），把右栏的 7 段正文也切了进去。
    // 那些正文同时以 HTML 文本出现，于是同一段文字在页面上出现两次 ——
    // 用户的原话是「把原文一起给切过来了」。
    const left = makeBlock('L', 0, 50, 100, 300, 20);
    const right = makeBlock('R', 1, 450, 700, 300, 20);
    const analysis = makeAnalysis([left, right], [0, 400, 800]);

    const flow = buildPageFlow(analysis, new Map(), {
      hasContent: () => true,
      figurePaths: [{ x: 111, y: 300, width: 316, height: 200 }],
      figureRegions: [{ x: 111, y: 300, width: 316, height: 200 }],
    });

    const crossing = flow.nodes.filter(
      (n): n is FlowSlice => n.kind === 'slice' && n.source.x === 111
    );
    expect(crossing).toHaveLength(1);
    expect(crossing[0].source.x).toBe(111);
    expect(crossing[0].source.width).toBe(316);
    // 右栏正文（x 450→750）与切片完全不相交
    expect(crossing[0].source.x + crossing[0].source.width).toBeLessThanOrEqual(450);
  });

  it('跨栏障碍不吞掉非归属栏的正文', () => {
    // 曾经的实现让跨栏障碍出现在每一栏的排布里，非归属栏生成 skip 片段，
    // 把该栏整个 y 区间吞掉 —— 正文凭空消失。
    const leftTop = makeBlock('LT', 0, 50, 100, 300, 20);
    const leftBottom = makeBlock('LB', 0, 50, 700, 300, 20);
    const rightMiddle = makeBlock('RM', 1, 450, 400, 300, 20);
    const analysis = makeAnalysis([leftTop, leftBottom, rightMiddle], [0, 400, 800]);

    const flow = buildPageFlow(analysis, new Map(), {
      hasContent: () => true,
      figurePaths: [{ x: 100, y: 200, width: 600, height: 300 }],
      figureRegions: [{ x: 100, y: 200, width: 600, height: 300 }],
    });

    // 右栏那段正文必须照常输出为文本
    const texts = textsOf(flow);
    expect(texts.map((t) => t.blockId)).toContain('RM');
  });
});

describe('行间公式块', () => {
  /** 公式块：isBodyText 但 formula = true */
  const formulaBlock = (id: string, x: number, y: number) => ({
    ...makeBlock(id, 0, x, y, 250, 20),
    formula: true,
    translatable: false,
    nonTranslatableReason: 'formula' as const,
  });

  it('公式输出为切片而不是文本节点 —— 文本化对公式必然有损', () => {
    const blocks = [
      makeBlock('a1', 0, 50, 100, 400, 100),
      formulaBlock('eq1', 120, 260),
      makeBlock('a2', 0, 50, 340, 400, 100),
    ];
    const flow = buildPageFlow(makeAnalysis(blocks, [0, 500, 1000]), translationMap(blocks));

    const texts = textsOf(flow);
    // 公式不出现在文本流里
    expect(texts.map((t) => t.source)).not.toContain('text of eq1');
    expect(texts).toHaveLength(2);

    // 它成了一张切片，且带 scaleToText 标记（渲染层据此按字号缩放而非拉满行宽）。
    // 裁切 x 用公式自身的范围（不带整栏页边距），所以不能按 source.x 找。
    const formulaSlices = flow.nodes.filter(
      (n): n is FlowSlice => n.kind === 'slice' && n.scaleToText === true
    );
    expect(formulaSlices).toHaveLength(1);
    // 裁切带垂直余量：上下各扩 0.35 × 字号（求和号/积分上下限经常超出 bbox）
    expect(formulaSlices[0].source.height).toBeCloseTo(20 + 2 * 12 * 0.35, 6);
  });

  it('公式块不会被登记为翻译源（译文 map 里查不到）', () => {
    // translationMap 以块 id 建键，这里直接验证文本节点上没有公式的 target
    const blocks = [
      formulaBlock('eq1', 120, 100),
      makeBlock('a1', 0, 50, 180, 400, 100),
    ];
    const flow = buildPageFlow(makeAnalysis(blocks, [0, 500, 1000]), translationMap(blocks));
    expect(textsOf(flow).map((t) => t.blockId)).toEqual(['a1']);
  });

  it('公式块不计入「正文重复切图」自检 —— 图像化是判定结果而非事故', () => {
    const blocks = [formulaBlock('eq1', 120, 100)];
    const flow = buildPageFlow(makeAnalysis(blocks, [0, 500, 1000]), translationMap(blocks));
    expect(flow.stats.duplicatedTextArea).toBe(0);
    expect(flow.stats.duplicatedBlockCount).toBe(0);
  });
});
