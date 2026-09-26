import { median } from './stats';
import type { Block, PageAnalysis } from '../types';

/**
 * 自检指标。
 *
 * 用途是「把 I0 的验收从目视变成可量化」，不是产品质量指标。
 *
 * 其中 outOfColumnBlocks 与 lineOverlapCount 应恒为 0，非 0 即说明算法有 bug；
 * 其余为描述性统计，用于判断当前参数是否需要调整。
 */
export interface SelfCheckReport {
  pageIndex: number;
  itemCount: number;
  lineCount: number;
  blockCount: number;
  columnCount: number;
  /** 每栏的文本项数量 */
  itemsPerColumn: number[];
  /**
   * 跨栏块数：bbox 宽度明显超过栏宽、横跨了栏缝。
   * 标题、作者行、宽表格属正常现象，不计为错误。
   */
  spanningBlocks: number;
  /**
   * 越栏块数：宽度在栏宽以内，却超出了所属栏的左右边界。
   * 这类块说明分栏或 bbox 计算有 bug，应恒为 0。
   */
  outOfColumnBlocks: number;
  /** 行内重叠次数：同一行内相邻文本项 bbox 重叠超过 2px。应恒为 0（非 0 说明宽度计算有误） */
  lineOverlapCount: number;
  /** 「与下一段的垂直间隙 ÷ 本段行高」的中位数。小于 1 表示几乎没有空隙放译文 */
  medianGapRatio: number;
  /** 可用间隙小于本段行高的块数（译文极可能压住下一段）。记录用，不要求为 0 */
  tightBlocks: number;
  /** 阅读顺序是否单调：按 readOrder 排序后 columnIndex 应单调不减 */
  readingOrderMonotonic: boolean;
  /** 中位行高（px） */
  medianLineHeight: number;
  /** 中位字号（px） */
  medianFontSize: number;
}

const OVERLAP_TOLERANCE = 2;

/**
 * 判断一个块覆盖了几栏。
 *
 * 判据是「块的 x 范围与哪几栏的 x 范围有交集」，而不是拿宽度和栏宽比。
 * 第一版用宽度比，结果把居中标题误判成"越栏"——标题宽 432px 小于栏宽 478px，
 * 但它从 230 开始横跨到 662，实际占了 2 栏。这是个分类错误，不是渲染错误。
 */
function columnsCovered(block: Block, boundaries: number[]): number {
  const left = block.bbox.x;
  const right = block.bbox.x + block.bbox.width;
  let count = 0;
  for (let k = 0; k < boundaries.length - 1; k += 1) {
    if (left < boundaries[k + 1] && right > boundaries[k]) count += 1;
  }
  return count;
}

export function selfCheck(analysis: PageAnalysis): SelfCheckReport {
  const { items, lines, blocks, columnBoundaries, width } = analysis;
  const columnCount = Math.max(1, columnBoundaries.length - 1);

  const itemsPerColumn = new Array(columnCount).fill(0) as number[];
  for (const item of items) {
    if (item.columnIndex >= 0 && item.columnIndex < columnCount) {
      itemsPerColumn[item.columnIndex] += 1;
    }
  }

  // 跨栏块 / 越栏块
  let spanningBlocks = 0;
  let outOfColumnBlocks = 0;
  for (const block of blocks) {
    const left = columnBoundaries[block.columnIndex] ?? 0;
    const right = columnBoundaries[block.columnIndex + 1] ?? width;
    const overflows = block.bbox.x < left - 1 || block.bbox.x + block.bbox.width > right + 1;
    if (!overflows) continue;
    if (columnsCovered(block, columnBoundaries) >= 2) {
      spanningBlocks += 1;
    } else {
      outOfColumnBlocks += 1;
    }
  }

  // 行内重叠
  const itemById = new Map(items.map((i) => [i.id, i]));
  let lineOverlapCount = 0;
  for (const line of lines) {
    const ordered = line.itemIds
      .map((id) => itemById.get(id))
      .filter((i): i is NonNullable<typeof i> => Boolean(i))
      .sort((a, b) => a.bbox.x - b.bbox.x);
    for (let i = 1; i < ordered.length; i += 1) {
      const prevRight = ordered[i - 1].bbox.x + ordered[i - 1].bbox.width;
      if (prevRight - ordered[i].bbox.x > OVERLAP_TOLERANCE) lineOverlapCount += 1;
    }
  }

  // 与下一段的可用间隙
  const byColumn = new Map<number, Block[]>();
  for (const block of blocks) {
    const list = byColumn.get(block.columnIndex) ?? [];
    list.push(block);
    byColumn.set(block.columnIndex, list);
  }
  const gapRatios: number[] = [];
  let tightBlocks = 0;
  for (const list of byColumn.values()) {
    const ordered = [...list].sort((a, b) => a.readOrder - b.readOrder);
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const current = ordered[i];
      const gap = ordered[i + 1].bbox.y - (current.bbox.y + current.bbox.height);
      const ratio = current.bbox.height > 0 ? gap / current.bbox.height : 0;
      gapRatios.push(ratio);
      if (ratio < 1) tightBlocks += 1;
    }
  }

  // 阅读顺序单调性
  const orderedBlocks = [...blocks].sort((a, b) => a.readOrder - b.readOrder);
  let readingOrderMonotonic = true;
  for (let i = 1; i < orderedBlocks.length; i += 1) {
    if (orderedBlocks[i].columnIndex < orderedBlocks[i - 1].columnIndex) {
      readingOrderMonotonic = false;
      break;
    }
  }

  return {
    pageIndex: analysis.pageIndex,
    itemCount: items.length,
    lineCount: lines.length,
    blockCount: blocks.length,
    columnCount,
    itemsPerColumn,
    spanningBlocks,
    outOfColumnBlocks,
    lineOverlapCount,
    medianGapRatio: Number(median(gapRatios).toFixed(2)),
    tightBlocks,
    readingOrderMonotonic,
    medianLineHeight: Number(median(lines.map((l) => l.bbox.height)).toFixed(1)),
    medianFontSize: Number(median(items.map((i) => i.fontSize)).toFixed(1)),
  };
}
