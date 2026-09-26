import { describe, expect, it } from 'vitest';

import { groupIntoLines, buildParagraphs } from '../paragraphBuilder';
import { analyzeTextStyle } from '../textStyle';
import type { Block, TextItem } from '../../types';

/**
 * 这些用例针对的是**已经真实踩过的坑**，不是假设的场景。
 * 每个 it 的注释里写明了它对应哪次翻车。
 */

const BODY_FONT = 10;

/** 造一个文本项。x/y 单位为「稿纸坐标」，够用即可 */
function item(
  id: string,
  str: string,
  x: number,
  y: number,
  fontSize = BODY_FONT,
  columnIndex = 0
): TextItem {
  return {
    id,
    str,
    bbox: { x, y, width: str.length * fontSize * 0.5, height: fontSize },
    baselineY: y + fontSize,
    fontSize,
    fontName: 'f1',
    fontFamily: 'sans-serif',
    bold: false,
    italic: false,
    rotated: false,
    columnIndex,
  };
}

describe('行 id 的跨栏唯一性', () => {
  it('两栏各自从 0 开始编号时，行 id 不得相同', () => {
    // 翻车现场：paragraphBuilder 曾用 `line-${index}` 生成行 id，
    // 而 groupIntoLines 是按栏调用的、index 每栏都从 0 开始。
    // 于是左栏的 line-0 与右栏的 line-0 撞名，analyzeTextStyle 里
    // `new Map(lines.map(l => [l.id, l]))` 被右栏覆盖，
    // 导致**左栏所有段落都拿右栏的行做样式分析**——
    // 图内标签因此拿到了正文字号，一路被判成正文并重排进文档。
    const left = groupIntoLines([item('a', 'left one', 10, 10, BODY_FONT, 0)]);
    const right = groupIntoLines([item('b', 'right one', 300, 10, BODY_FONT, 1)]);

    expect(left[0].id).not.toBe(right[0].id);
    expect(new Set([...left, ...right].map((l) => l.id)).size).toBe(2);
  });
});

describe('正文 vs 图内文字的判定', () => {
  /** 用两栏版式造一页：左栏是图内小字，右栏是正文 */
  function page() {
    const items: TextItem[] = [
      // 左栏：图内标签，字号只有正文的一半
      item('f1', '3x3 conv, 64', 40, 100, BODY_FONT * 0.49, 0),
      item('f2', 'pool, /2', 40, 114, BODY_FONT * 0.49, 0),
      // 右栏：正文
      item('b1', 'We first evaluate 18-layer and 34-layer plain networks.', 320, 100, BODY_FONT, 1),
      item('b2', 'The 34-layer plain net has higher training error.', 320, 114, BODY_FONT, 1),
    ];
    const boundaries = [0, 260, 612];
    const lines = [
      ...groupIntoLines(items.filter((i) => i.columnIndex === 0)),
      ...groupIntoLines(items.filter((i) => i.columnIndex === 1)),
    ];
    const blocks: Block[] = [
      ...buildParagraphs(lines.filter((l) => l.columnIndex === 0), 0),
      ...buildParagraphs(lines.filter((l) => l.columnIndex === 1), 0),
    ];
    return { items, lines, blocks, boundaries };
  }

  it('字号明显更小的块被判为图内文字，且原因可解释', () => {
    const { items, lines, blocks, boundaries } = page();
    const style = analyzeTextStyle(items, lines, blocks, boundaries);

    const figure = blocks.find((b) => b.columnIndex === 0)!;
    const body = blocks.find((b) => b.columnIndex === 1)!;

    expect(style.styleByBlockId.get(figure.id)?.isBodyText).toBe(false);
    expect(style.styleByBlockId.get(figure.id)?.figureReason).toBe('font-size');
    expect(style.styleByBlockId.get(body.id)?.isBodyText).toBe(true);
    expect(style.styleByBlockId.get(body.id)?.figureReason).toBeNull();
  });

  it('含行内公式的正文不会被「断点密度」误杀', () => {
    // 翻车现场：曾用 gapsPerLine ≥ 0.8 判图内标签，结果真实正文里的
    // `F(x, {Wi})` 被 pdf.js 拆成 F / ( / x / , / {Wi} / ) 多个文本项，
    // 断点/行冲到 3.3，正文整段被判成图像。图内标签反而常有 0.0。
    // 两个分布几乎重叠，该判据已被移除（现仅作诊断字段保留）。
    const items: TextItem[] = [
      item('m1', 'Here', 40, 100),
      item('m2', 'x', 70, 100),
      item('m3', 'and', 85, 100),
      item('m4', 'y', 110, 100),
      item('m5', 'are', 125, 100),
      item('m6', 'the', 150, 100),
      item('m7', 'input', 175, 100),
      item('m8', 'and', 210, 100),
      item('m9', 'output', 240, 100),
      item('m10', 'vectors.', 290, 100),
    ];
    const boundaries = [0, 612];
    const lines = groupIntoLines(items);
    const blocks = buildParagraphs(lines, 0);
    const style = analyzeTextStyle(items, lines, blocks, boundaries);

    expect(style.styleByBlockId.get(blocks[0].id)?.gapsPerLine).toBeGreaterThan(2);
    expect(style.styleByBlockId.get(blocks[0].id)?.isBodyText).toBe(true);
  });
});

describe('模糊区间交给注入的图形探测', () => {
  /** 造一个「字号与正文相同」的块 —— 实测图上确实存在这种标签 */
  function page() {
    const items: TextItem[] = [
      item('x1', 'F(x)', 40, 100, BODY_FONT),
      item('x2', 'relu', 80, 100, BODY_FONT),
      item('x3', 'identity', 130, 100, BODY_FONT),
      item('n1', 'Residual Network. Based on the above plain network.', 320, 100, BODY_FONT, 1),
      item('n2', 'We insert shortcut connections into the network.', 320, 114, BODY_FONT, 1),
    ];
    const boundaries = [0, 260, 612];
    const lines = [
      ...groupIntoLines(items.filter((i) => i.columnIndex === 0)),
      ...groupIntoLines(items.filter((i) => i.columnIndex === 1)),
    ];
    const blocks: Block[] = [
      ...buildParagraphs(lines.filter((l) => l.columnIndex === 0), 0),
      ...buildParagraphs(lines.filter((l) => l.columnIndex === 1), 0),
    ];
    return { items, lines, blocks, boundaries };
  }

  it('探测函数返回 true 时判为图内文字', () => {
    const { items, lines, blocks, boundaries } = page();
    const style = analyzeTextStyle(items, lines, blocks, boundaries, {
      isInsideFigure: () => true,
    });
    const figure = blocks.find((b) => b.columnIndex === 0)!;
    expect(style.styleByBlockId.get(figure.id)?.isBodyText).toBe(false);
    expect(style.styleByBlockId.get(figure.id)?.figureReason).toBe('graphics-region');
  });

  it('探测函数返回 false 时仍判为正文', () => {
    const { items, lines, blocks, boundaries } = page();
    const style = analyzeTextStyle(items, lines, blocks, boundaries, {
      isInsideFigure: () => false,
    });
    const body = blocks.find((b) => b.columnIndex === 0)!;
    expect(style.styleByBlockId.get(body.id)?.isBodyText).toBe(true);
  });

  it('只在字号落入模糊区间时才调用探测函数', () => {
    // 理由：探测依赖像素/矢量，比字号判据脆得多。只在字号真的分不出来时才用它，
    // 才不会让它的不确定性污染本来能干净判定的部分。
    const items: TextItem[] = [
      // 图内小字（0.49 倍）
      item('s1', '3x3 conv, 64', 40, 100, BODY_FONT * 0.49, 0),
      item('s2', 'pool, /2', 40, 114, BODY_FONT * 0.49, 0),
      // 正文（1.00 倍）。字符数要压过其他项，才能成为「按字符数加权的众数」
      item(
        'b1',
        'Residual Network. Based on the above plain network, we insert shortcut connections.',
        320,
        100,
        BODY_FONT,
        1
      ),
      item(
        'b2',
        'We first evaluate 18-layer and 34-layer plain networks on ImageNet.',
        320,
        114,
        BODY_FONT,
        1
      ),
      // 标题（1.20 倍），与正文拉开距离，单独成块
      item('h1', '4. Experiments', 320, 200, BODY_FONT * 1.2, 1),
    ];
    const boundaries = [0, 260, 612];
    const lines = [
      ...groupIntoLines(items.filter((i) => i.columnIndex === 0)),
      ...groupIntoLines(items.filter((i) => i.columnIndex === 1)),
    ];
    const blocks: Block[] = [
      ...buildParagraphs(lines.filter((l) => l.columnIndex === 0), 0),
      ...buildParagraphs(lines.filter((l) => l.columnIndex === 1), 0),
    ];

    const probed = new Set<string>();
    const style = analyzeTextStyle(items, lines, blocks, boundaries, {
      isInsideFigure: (bbox) => {
        probed.add(`${bbox.x},${bbox.y},${bbox.width},${bbox.height}`);
        return false;
      },
    });

    const scaleOf = (id: string) => style.styleByBlockId.get(id)!.fontScale;
    const small = blocks.find((b) => b.columnIndex === 0)!;
    const heading = blocks.find((b) => b.text.includes('Experiments'))!;

    /** 块内任一行是否被探测过 */
    const anyLineProbed = (block: Block) =>
      block.lineIds.some((lineId) => {
        const line = lines.find((l) => l.id === lineId)!;
        return probed.has(`${line.bbox.x},${line.bbox.y},${line.bbox.width},${line.bbox.height}`);
      });

    // 前提检查：三个块确实分别落在「明显小 / 模糊 / 明显大」三段
    expect(scaleOf(small.id)).toBeLessThan(0.85);
    expect(scaleOf(heading.id)).toBeGreaterThan(1.05);

    expect(anyLineProbed(small)).toBe(false);
    expect(anyLineProbed(heading)).toBe(false);
    // 模糊区间的块确实被探测了，否则上面的断言只是空转
    expect(probed.size).toBeGreaterThan(0);
  });

  it('块内只有少数行落在图形里时，不判为图内文字', () => {
    // 翻车现场：判据原本是「块的包围盒是否与图形相交」。真实论文里有一段正文
    // 因为段落切分不理想被并成了跨 800px 的巨型块，包围盒自然与图 2 相交，
    // 于是整段正文被当成图内文字保留了。改成按行聚合后这个误判消失。
    const items: TextItem[] = [
      item('p1', 'are comparably good or better than the constructed', 40, 100, BODY_FONT, 0),
      item('p2', 'counterparts, and we attribute this to the difficulty', 40, 114, BODY_FONT, 0),
      item('p3', 'of optimization on very deep plain networks.', 40, 128, BODY_FONT, 0),
    ];
    const boundaries = [0, 612];
    const lines = groupIntoLines(items);
    const blocks = buildParagraphs(lines, 0);

    // 只有第一行「在图形里」，其余两行不在 → 命中比例 1/3 < 0.6
    const firstLineId = blocks[0].lineIds[0];
    const firstLine = lines.find((l) => l.id === firstLineId)!;
    const style = analyzeTextStyle(items, lines, blocks, boundaries, {
      isInsideFigure: (bbox) =>
        bbox.y === firstLine.bbox.y &&
        bbox.x === firstLine.bbox.x &&
        bbox.width === firstLine.bbox.width,
    });

    expect(style.styleByBlockId.get(blocks[0].id)?.isBodyText).toBe(true);
  });

  it('块内所有行都落在图形里时，判为图内文字', () => {
    const items: TextItem[] = [
      item('f1', '3x3 conv, 64', 40, 100, BODY_FONT, 0),
      item('f2', 'pool, /2', 40, 114, BODY_FONT, 0),
      item('b1', 'Residual Network. Based on the above plain network.', 320, 100, BODY_FONT, 1),
      item('b2', 'We insert shortcut connections into the network.', 320, 114, BODY_FONT, 1),
    ];
    const boundaries = [0, 260, 612];
    const lines = [
      ...groupIntoLines(items.filter((i) => i.columnIndex === 0)),
      ...groupIntoLines(items.filter((i) => i.columnIndex === 1)),
    ];
    const blocks: Block[] = [
      ...buildParagraphs(lines.filter((l) => l.columnIndex === 0), 0),
      ...buildParagraphs(lines.filter((l) => l.columnIndex === 1), 0),
    ];
    const target = blocks.find((b) => b.columnIndex === 0)!;

    const style = analyzeTextStyle(items, lines, blocks, boundaries, {
      isInsideFigure: (bbox) =>
        target.lineIds.some((lineId) => {
          const line = lines.find((l) => l.id === lineId)!;
          return line.bbox.y === bbox.y;
        }),
    });

    expect(style.styleByBlockId.get(target.id)?.isBodyText).toBe(false);
    expect(style.styleByBlockId.get(target.id)?.figureReason).toBe('graphics-region');
  });
});
