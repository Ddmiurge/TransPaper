import { describe, expect, it } from 'vitest';

import { detectTableRegions } from '../tables';
import type { Block, TextItem, TextLine } from '../../types';

const BODY = 20; // 正文字号（px）

/** 测试内的 items 注册表：line() 构造时把 item 收集进来，测式里整体传给检测器 */
const allItems: TextItem[] = [];

let itemSeq = 0;
function item(x: number, width: number, y: number, column = 0): TextItem {
  itemSeq += 1;
  const it: TextItem = {
    id: `i${itemSeq}`,
    str: 'cell',
    bbox: { x, y, width, height: BODY },
    baselineY: y + BODY,
    fontSize: BODY,
    fontName: 'F',
    fontFamily: 'serif',
    bold: false,
    italic: false,
    rotated: false,
    columnIndex: column,
  };
  allItems.push(it);
  return it;
}

function line(id: string, its: TextItem[], column = 0): TextLine {
  const x0 = Math.min(...its.map((i) => i.bbox.x));
  const x1 = Math.max(...its.map((i) => i.bbox.x + i.bbox.width));
  const y = its[0].bbox.y;
  return {
    id,
    itemIds: its.map((i) => i.id),
    text: its.map((i) => i.str).join(' '),
    spans: [],
    bbox: { x: x0, y, width: x1 - x0, height: BODY },
    baselineY: y + BODY,
    columnIndex: column,
    fontSize: BODY,
  };
}

function block(id: string, lineIds: string[], overrides: Partial<Block> = {}): Block {
  return {
    id,
    pageIndex: 0,
    columnIndex: 0,
    readOrder: 0,
    bbox: { x: 0, y: 0, width: 300, height: 20 },
    lineIds,
    text: '',
    spans: [],
    fontSize: BODY,
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

/** 造一行「3 个单元格」的表格行：单元格宽 60、间隙 30（> cellGap=20） */
function tableRow(id: string, y: number, column = 0): TextLine {
  return line(id, [item(50, 60, y, column), item(140, 60, y, column), item(230, 60, y, column)], column);
}

/** 造一行正文（词间隙 8px，远小于 cellGap） */
function textLine(id: string, y: number): TextLine {
  return line(id, [item(50, 80, y), item(138, 80, y), item(226, 80, y)]);
}

/** 造一行「含行内公式/绕排标签的正文行」——大间隙 + 大量英文长词（单栏 p6 误报形态） */
function proseWithMathLine(id: string, y: number): TextLine {
  return line(id, [
    itemStr(50, 200, y, 'and joint training. As shown in Table 2, monolingual probes can'),
    itemStr(300, 40, y, '→EN'),
    itemStr(370, 40, y, '→C'),
  ]);
}

function itemStr(x: number, width: number, y: number, str: string): TextItem {
  const it = item(x, width, y);
  it.str = str;
  return it;
}

function run(lines: TextLine[], blocks: Block[]) {
  return detectTableRegions(lines, allItems, BODY, blocks);
}

describe('detectTableRegions', () => {
  it('4 行 × 3 列的网格识别为 1 个表格区域', () => {
    allItems.length = 0;
    const rows = [0, 1, 2, 3].map((r) => tableRow(`l${r}`, 100 + r * BODY * 0.8));
    const regions = run(rows, [block('b', rows.map((l) => l.id))]);
    expect(regions).toHaveLength(1);
    expect(regions[0].lineIds).toHaveLength(4);
    expect(regions[0].bbox.y).toBeLessThan(100);
  });

  it('行距过大（间隔超过 2 倍行高）不构成同一张表', () => {
    allItems.length = 0;
    const rows = [0, 1, 2].map((r) => tableRow(`l${r}`, 100 + r * BODY * 4));
    expect(run(rows, [block('b', rows.map((l) => l.id))])).toHaveLength(0);
  });

  it('不足 3 行不成表（宁可漏判）', () => {
    allItems.length = 0;
    const rows = [tableRow('l0', 100), tableRow('l1', 116)];
    expect(run(rows, [block('b', rows.map((l) => l.id))])).toHaveLength(0);
  });

  it('间隙位置不跨行对齐（没有共享列边界）不成表', () => {
    allItems.length = 0;
    // 三行的间隙中心互相错开 40px 以上
    const r0 = line('l0', [item(50, 60, 100), item(150, 60, 100), item(280, 60, 100)]);
    const r1 = line('l1', [item(50, 60, 116), item(190, 60, 116), item(300, 60, 116)]);
    const r2 = line('l2', [item(50, 60, 132), item(120, 60, 132), item(310, 60, 132)]);
    const rows = [r0, r1, r2];
    expect(run(rows, [block('b', rows.map((l) => l.id))])).toHaveLength(0);
  });

  it('表格行后的正文行不是候选行，不会被卷进区域', () => {
    allItems.length = 0;
    const rows = [tableRow('l0', 100), tableRow('l1', 116), tableRow('l2', 132), textLine('t0', 148)];
    const regions = run(rows, [block('b', ['l0', 'l1', 'l2']), block('p', ['t0'])]);
    expect(regions).toHaveLength(1);
    expect(regions[0].lineIds).toEqual(['l0', 'l1', 'l2']);
  });

  it('公式 / 文献 / 作者 / 标题块 的行不参与表格判定', () => {
    const cases: Array<Partial<Block>> = [
      { formula: true },
      { nonTranslatableReason: 'references' },
      { nonTranslatableReason: 'authors' },
      { headingLevel: 1 },
    ];
    for (const override of cases) {
      allItems.length = 0;
      const rows = [tableRow('l0', 100), tableRow('l1', 116), tableRow('l2', 132)];
      expect(
        run(rows, [block('b', rows.map((l) => l.id), override)]),
        `override=${JSON.stringify(override)}`
      ).toHaveLength(0);
    }
  });

  it('小字号（已被标为图内文字）的表格行仍被识别——ACL 形态', () => {
    allItems.length = 0;
    // ACL 实测：表格行 fontScale 0.38、isBodyText=false，但它们就是表格
    const rows = [0, 1, 2].map((r) => tableRow(`l${r}`, 100 + r * BODY * 0.6));
    const regions = run(rows, [block('b', rows.map((l) => l.id), { isBodyText: false, fontScale: 0.38 })]);
    expect(regions).toHaveLength(1);
  });

  it('正文 + 行尾行内公式的段落不成表（长词密度闸）', () => {
    allItems.length = 0;
    // 单栏样本 p6 的真实误报形态：每行都是「正文长句 + 行尾数学项」，
    // 间隙大且行尾对齐——靠长词密度排除
    const rows = [0, 1, 2, 3].map((r) => proseWithMathLine(`l${r}`, 100 + r * 17));
    expect(run(rows, [block('b', rows.map((l) => l.id))])).toHaveLength(0);
  });

  it('不同栏的相同网格各自成表，不跨栏合并', () => {
    allItems.length = 0;
    const col0 = [0, 1, 2].map((r) => tableRow(`a${r}`, 100 + r * BODY * 0.8, 0));
    const col1 = [0, 1, 2].map((r) => tableRow(`b${r}`, 100 + r * BODY * 0.8, 1));
    const rows = [...col0, ...col1];
    const regions = run(rows, [block('ba', col0.map((l) => l.id)), block('bb', col1.map((l) => l.id))]);
    expect(regions).toHaveLength(2);
  });
});
