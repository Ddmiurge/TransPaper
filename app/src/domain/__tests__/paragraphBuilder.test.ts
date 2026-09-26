import { describe, expect, it } from 'vitest';

import { buildParagraphs, groupIntoLines } from '../paragraphBuilder';
import type { TextItem } from '../../types';

/**
 * 构造一个文本项。
 * 与 domain/geometry.ts 的约定保持一致：bbox.y = baseline - fontSize，bbox.height = fontSize × 1.15
 */
function item(
  id: string,
  str: string,
  x: number,
  baselineY: number,
  width: number,
  fontSize = 10,
  style: { bold?: boolean; italic?: boolean } = {}
): TextItem {
  return {
    id,
    str,
    bbox: { x, y: baselineY - fontSize, width, height: fontSize * 1.15 },
    baselineY,
    fontSize,
    fontName: 'test',
    fontFamily: 'sans-serif',
    bold: style.bold ?? false,
    italic: style.italic ?? false,
    rotated: false,
    columnIndex: 0,
  };
}

describe('groupIntoLines', () => {
  it('空输入返回空数组', () => {
    expect(groupIntoLines([])).toEqual([]);
  });

  it('单个文本项聚成一行', () => {
    const lines = groupIntoLines([item('a', 'Hello', 10, 100, 50)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Hello');
  });

  it('基线相同的多个文本项合并成一行，并按 x 排序拼接', () => {
    const lines = groupIntoLines([
      item('b', 'world', 60, 100, 50),
      item('a', 'Hello', 10, 100, 45),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Hello world');
    expect(lines[0].bbox.x).toBe(10);
    expect(lines[0].bbox.x + lines[0].bbox.width).toBe(110);
  });

  it('基线相差超过容差的文本项分成两行', () => {
    const lines = groupIntoLines([
      item('a', 'First', 10, 100, 50),
      item('b', 'Second', 10, 130, 55),
    ]);
    expect(lines).toHaveLength(2);
  });

  it('同一行内相邻无间隙的文本项不插入空格', () => {
    const lines = groupIntoLines([
      item('a', 'Re', 10, 100, 12),
      item('b', 'sNet', 22, 100, 30),
    ]);
    expect(lines[0].text).toBe('ResNet');
    expect(lines[0].bbox.width).toBe(42);
  });

  it('同一行内间隙足够大时插入空格', () => {
    const lines = groupIntoLines([
      item('a', 'Hello', 10, 100, 45),
      item('b', 'world', 70, 100, 40),
    ]);
    expect(lines[0].text).toBe('Hello world');
  });
});

describe('buildParagraphs', () => {
  it('空输入返回空数组', () => {
    expect(buildParagraphs([], 0)).toEqual([]);
  });

  it('单行构成一个段落', () => {
    const lines = groupIntoLines([item('a', 'Only line', 10, 100, 60)]);
    const blocks = buildParagraphs(lines, 0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('Only line');
    expect(blocks[0].readOrder).toBe(0);
  });

  it('行距紧凑的行归为同一段', () => {
    const items = [
      item('a', 'line one', 10, 100, 60),
      item('b', 'line two', 10, 112, 60),
      item('c', 'line three', 10, 124, 70),
    ];
    const blocks = buildParagraphs(groupIntoLines(items), 0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('line one line two line three');
  });

  it('行距明显变大的位置断开成两段', () => {
    const items = [
      item('a', 'first paragraph', 10, 100, 100),
      item('b', 'still first', 10, 112, 80),
      item('c', 'second paragraph', 10, 140, 110),
      item('d', 'still second', 10, 152, 90),
    ];
    const blocks = buildParagraphs(groupIntoLines(items), 0);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe('first paragraph still first');
    expect(blocks[1].text).toBe('second paragraph still second');
  });

  it('字号变化触发新段落（标题场景）', () => {
    const items = [
      item('a', '正文第一行', 10, 100, 70, 10),
      item('b', 'Section Title', 10, 130, 90, 16),
      item('c', '正文第二行', 10, 152, 70, 10),
    ];
    const blocks = buildParagraphs(groupIntoLines(items), 0);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const titles = blocks.filter((b) => b.text.includes('Section Title'));
    expect(titles).toHaveLength(1);
  });

  it('行尾连字符在拼接时还原', () => {
    const items = [
      item('a', 'represen-', 10, 100, 60),
      item('b', 'tation learning', 10, 112, 90),
    ];
    const blocks = buildParagraphs(groupIntoLines(items), 0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('representation learning');
  });

  it('段落的 bbox 是其所有行 bbox 的并集', () => {
    const items = [
      item('a', 'short', 10, 100, 40),
      item('b', 'a much longer line', 10, 112, 120),
    ];
    const blocks = buildParagraphs(groupIntoLines(items), 0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].bbox.x).toBe(10);
    expect(blocks[0].bbox.width).toBe(120);
    expect(blocks[0].bbox.y).toBe(90);
    expect(blocks[0].bbox.y + blocks[0].bbox.height).toBeCloseTo(112 - 10 + 11.5, 4);
  });

  it('readOrder 编码了栏序号（跨栏不串序）', () => {
    const linesCol0 = groupIntoLines([
      Object.assign(item('a', 'left col', 10, 100, 60), { columnIndex: 0 }),
    ]);
    const linesCol1 = groupIntoLines([
      Object.assign(item('b', 'right col', 400, 100, 60), { columnIndex: 1 }),
    ]);
    const left = buildParagraphs(linesCol0, 0);
    const right = buildParagraphs(linesCol1, 0);
    expect(right[0].readOrder).toBeGreaterThan(left[0].readOrder);
  });
});

describe('样式片段（粗体小标题 / 斜体术语）', () => {
  /** 取片段对应的子串，便于断言 */
  const sliceOf = (text: string, span: { start: number; end: number }) =>
    text.slice(span.start, span.end);

  it('段首粗体小标题被识别为独立片段', () => {
    // 论文里的 \paragraph{...} 写法：粗体引导语 + 同行正文。
    // 纯文本化之后两者会连成一句，必须靠片段把粗体部分标出来，
    // 否则排出来的段落没有结构，一眼就不像原论文。
    const items = [
      item('a', 'Identity vs. Projection Shortcuts.', 10, 100, 170, 10, { bold: true }),
      item('b', 'We have shown that', 184, 100, 92),
    ];
    const lines = groupIntoLines(items);
    const blocks = buildParagraphs(lines, 0);

    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block.text).toBe('Identity vs. Projection Shortcuts. We have shown that');

    const boldPart = block.spans.filter((s) => s.bold).map((s) => sliceOf(block.text, s));
    expect(boldPart).toEqual(['Identity vs. Projection Shortcuts.']);
  });

  it('斜体术语被识别，且与相邻的粗体片段不合并', () => {
    const items = [
      item('a', 'Identity', 10, 100, 40, 10, { bold: true }),
      item('b', 'vs', 54, 100, 14, 10, { italic: true }),
      item('c', 'Projection', 72, 100, 52, 10, { bold: true }),
    ];
    const lines = groupIntoLines(items);
    const blocks = buildParagraphs(lines, 0);
    const block = blocks[0];

    const styles = block.spans.map((s) => ({
      text: sliceOf(block.text, s),
      bold: s.bold,
      italic: s.italic,
    }));
    expect(styles).toEqual([
      { text: 'Identity', bold: true, italic: false },
      { text: 'vs', bold: false, italic: true },
      { text: 'Projection', bold: true, italic: false },
    ]);
  });

  it('片段偏移在跨行拼接后仍然正确（含行尾连字符还原）', () => {
    // 行尾连字符会被去掉，导致后续文本整体左移一位；
    // 如果片段偏移没有跟着调整，粗体范围就会错位。
    // 断词发生在行尾：第一行以 "degrad-" 收尾，第二行接 "ation"
    const items = [
      item('a', 'The', 10, 100, 22),
      item('b', 'degrad-', 36, 100, 45),
      item('c', 'ation', 10, 114, 38),
      item('d', 'matters', 52, 114, 52, 10, { bold: true }),
    ];
    const lines = groupIntoLines(items);
    const blocks = buildParagraphs(lines, 0);
    const block = blocks[0];

    // "degrad-" + "ation" → "degradation"，整体左移一位
    expect(block.text).toBe('The degradation matters');
    const boldPart = block.spans.filter((s) => s.bold).map((s) => sliceOf(block.text, s));
    expect(boldPart).toEqual(['matters']);
  });

  it('全篇同样式时只有一个片段，不产生碎片', () => {
    const items = [
      item('a', 'plain words here', 10, 100, 100),
      item('b', 'and more plain words', 10, 114, 120),
    ];
    const blocks = buildParagraphs(groupIntoLines(items), 0);
    expect(blocks[0].spans).toHaveLength(1);
    expect(blocks[0].spans[0]).toMatchObject({ start: 0, bold: false, italic: false });
    expect(blocks[0].spans[0].end).toBe(blocks[0].text.length);
  });
});

describe('参考文献条目切分', () => {
  /** 造一行：x 是左边缘（悬挂缩进靠它区分首行与续行） */
  const line = (id: string, text: string, x: number, y: number, width = 340): TextItem =>
    item(id, text, x, y, width);

  it('带 [N] 编号的文献表按编号切开，不再并成一个巨型块', () => {
    // 翻车现场：ResNet 第 9 页的 `[1] Y. Bengio…` 那一段有 **63 行**、y 从 136 跨到 1068，
    // 整栏文献被并成一段 —— 用户看到的就是「引用全都挤成了一堆」。
    const lines: TextItem[] = [];
    // 三条文献，每条 2 行；首行顶格（x=75），续行缩进（x=93）
    const entries = [
      '[1] Y. Bengio, P. Simard, and P. Frasconi. Learning long-term dependencies.',
      '[2] C. M. Bishop. Neural networks for pattern recognition. Oxford, 1995.',
      '[3] W. L. Briggs, S. F. McCormick, et al. A Multigrid Tutorial. SIAM, 2000.',
    ];
    entries.forEach((text, i) => {
      const y = 136 + i * 44;
      lines.push(line(`a${i}`, text, 75, y));
      lines.push(line(`b${i}`, 'continuation of the entry', 93, y + 14));
    });

    const blocks = buildParagraphs(groupIntoLines(lines), 0);

    expect(blocks).toHaveLength(3);
    expect(blocks[0].text.startsWith('[1] Y. Bengio')).toBe(true);
    expect(blocks[1].text.startsWith('[2] C. M. Bishop')).toBe(true);
    expect(blocks[2].text.startsWith('[3] W. L. Briggs')).toBe(true);
  });

  it('无编号的悬挂缩进列表也按顶格行切开', () => {
    // 某些期刊的文献表不带编号。悬挂缩进的特征是「缩进行占多数、顶格行占少数」，
    // 这与正文（续行全部顶格）恰好相反。
    const lines = [
      line('a1', 'First entry starts flush left here', 75, 100),
      line('a2', 'and its continuation is indented', 93, 114),
      line('a3', 'more continuation text for entry one', 93, 128),
      line('b1', 'Second entry also flush left', 75, 146),
      line('b2', 'its continuation indented too', 93, 160),
      line('b3', 'and another continuation line', 93, 174),
    ];

    const blocks = buildParagraphs(groupIntoLines(lines), 0);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text.startsWith('First entry')).toBe(true);
    expect(blocks[1].text.startsWith('Second entry')).toBe(true);
  });

  it('普通首行缩进的段落不受影响 —— 判据不能把正文切碎', () => {
    // 这是最重要的回归：正文的形态是「首行缩进、续行全部顶格」，
    // 与悬挂缩进恰好相反。若判据写反，一段 5 行正文会变成 4 段。
    const lines = [
      line('l1', 'A normal paragraph whose first line is indented.', 93, 100),
      line('l2', 'The rest of the lines sit at the left margin,', 75, 114),
      line('l3', 'which is exactly the opposite of a hanging indent.', 75, 128),
      line('l4', 'So this must stay one single block.', 75, 142),
    ];

    const blocks = buildParagraphs(groupIntoLines(lines), 0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toMatch(/^A normal paragraph/);
  });

  it('编号不递增的 [N] 不触发切分（正文里的偶然引用）', () => {
    // 正文里 `[1]` 出现在句中并不罕见；只有**递增序列**才是文献条目边界
    const lines = [
      line('l1', 'As shown in [1] and later confirmed by [1] again,', 75, 100),
      line('l2', 'the method works as described in the paper.', 75, 114),
    ];
    const blocks = buildParagraphs(groupIntoLines(lines), 0);
    expect(blocks).toHaveLength(1);
  });
});

describe('上下标识别（script span）', () => {
  /** 找到覆盖指定文本的 span */
  const spanOf = (block: ReturnType<typeof buildParagraphs>[number], chunk: string) =>
    block.spans.find((s) => block.text.slice(s.start, s.end) === chunk);

  it('下标（更小字号 + 更低基线）标记为 sub，不再拍平', () => {
    // 翻车现场：$W_i$ 提取后变成全尺寸的 `Wi` —— 数学含义直接丢失。
    // 下标是独立文本项：字号约为主字号的 0.7 倍、基线更低（y 向下，基线值更大）。
    const lines = groupIntoLines([
      item('a', 'W', 10, 100, 10),
      item('b', 'i', 20, 103.5, 5, 7),
      item('c', ' = F(x)', 25, 100, 50),
    ]);
    const blocks = buildParagraphs(lines, 0);
    expect(blocks[0].text).toBe('Wi = F(x)');
    const sub = spanOf(blocks[0], 'i');
    expect(sub?.script).toBe('sub');
    // 正文部分不受影响
    expect(spanOf(blocks[0], 'W')?.script).toBeUndefined();
    expect(spanOf(blocks[0], ' = F(x)')?.script).toBeUndefined();
  });

  it('上标（更小字号 + 更高基线）标记为 sup', () => {
    // 脚注引用标记：`text2` 的 2 是上标
    const lines = groupIntoLines([
      item('a', 'text', 10, 100, 30),
      item('b', '2', 40, 96.5, 5, 7),
      item('c', ' This hypothesis', 45, 100, 80),
    ]);
    const blocks = buildParagraphs(lines, 0);
    const sup = spanOf(blocks[0], '2');
    expect(sup?.script).toBe('sup');
    expect(spanOf(blocks[0], ' This hypothesis')?.script).toBeUndefined();
  });

  it('字号小但基线在主基线上的项不判为上下标', () => {
    // 判据必须双条件：只有「字号小 + 基线偏离」才是上下标。
    // 小型大写字母（字号小、基线齐）判成下标是错的。
    const lines = groupIntoLines([
      item('a', 'IEEE', 10, 100, 30, 8),
      item('b', ' Transactions', 40, 100, 80),
    ]);
    const blocks = buildParagraphs(lines, 0);
    expect(blocks[0].spans.every((s) => s.script === undefined)).toBe(true);
  });

  it('script 信息跨行合并到块时保留', () => {
    // 第一行带下标，第二行是普通文本 —— 走 makeBlock 的行合并路径后仍要保留
    const lines = groupIntoLines([
      item('a', 'Use W', 10, 100, 35),
      item('b', 'i', 45, 103.5, 5, 7),
      item('c', ' to index the inputs.', 50, 100, 120),
      item('d', 'The second sentence continues here.', 10, 120, 200),
    ]);
    const blocks = buildParagraphs(lines, 0);
    expect(blocks).toHaveLength(1);
    const sub = spanOf(blocks[0], 'i');
    expect(sub?.script).toBe('sub');
  });
});
