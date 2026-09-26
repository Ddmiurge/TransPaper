import type { TextItem } from '../types';

/**
 * 栏检测（I0 修订版）
 *
 * ── 为什么不用"完全空白"法 ──
 * 第一版把"被任何文本覆盖的桶"标为已占用，再找连续空白区间当栏缝。
 * 实测在真实双栏论文上完全失败：论文标题、作者行、脚注都是居中/通栏元素，
 * 它们横跨页面中线，把栏缝所在的位置也标记成"已覆盖"，于是检不出任何栏缝。
 *
 * ── 现在的做法 ──
 * 不问"是否被覆盖"，而问"被覆盖了多少次"。
 * 栏缝区域只会被零星几个通栏元素覆盖（计数 1-5），而栏内区域被几十行正文覆盖（计数几十）。
 * 这个量级差异非常稳定，因此用「窗口内平均覆盖计数」的相对阈值来判定栏缝。
 *
 * 已知缺陷（I0 明确接受，I1 用更强的版面分析解决）：
 *   - 栏内大面积留白（如居中公式、算法伪代码框）可能被误判为栏缝
 *   - 三栏及以上未做验证
 */
export interface ColumnDetectOptions {
  /** 投影桶宽（px），越小定位越精细 */
  bucketSize: number;
  /** 判定窗口宽度（px），用于平滑覆盖计数 */
  windowSize: number;
  /** 判为栏缝所需的连续低覆盖区间最小宽度（px） */
  minGutterWidth: number;
  /** 相对阈值：窗口平均覆盖计数低于「峰值 × 此比例」才算栏缝 */
  thresholdRatio: number;
  /** 栏缝只能出现在距页面左右边缘此比例的范围内 */
  marginRatio: number;
  /**
   * 最多接受几条栏缝。
   *
   * I0 的范围是「只保证双栏」，所以默认 1（即最多 2 栏）。
   * 这不是为了简化实现，而是为了给误检加一道闸：整页图表那种不规则布局会产生
   * 多条伪栏缝（实测第 4 页误检出 3 条），限制数量能让它退化为 1 条而不是 3 条。
   * I1 用真正的版面分析后可以放开。
   */
  maxSplits: number;
}

export const DEFAULT_COLUMN_OPTIONS: ColumnDetectOptions = {
  bucketSize: 2,
  windowSize: 16,
  minGutterWidth: 10,
  thresholdRatio: 0.3,
  marginRatio: 0.15,
  maxSplits: 1,
};

export interface ColumnLayout {
  /** 栏缝中心 x */
  splits: number[];
  /** 栏边界，长度 = 栏数 + 1，首元素 0，末元素 pageWidth */
  boundaries: number[];
  /** 每栏包含的 item id */
  itemIdsByColumn: string[][];
}

/** 检测栏缝位置。返回空数组表示判定为单栏。 */
export function detectColumnSplits(
  boxes: Array<{ x: number; width: number }>,
  pageWidth: number,
  opts: Partial<ColumnDetectOptions> = {}
): number[] {
  const o = { ...DEFAULT_COLUMN_OPTIONS, ...opts };
  if (pageWidth <= 0 || boxes.length === 0) return [];

  const nBuckets = Math.max(1, Math.ceil(pageWidth / o.bucketSize));
  const coverage = new Float64Array(nBuckets);

  for (const b of boxes) {
    const start = Math.max(0, Math.floor(b.x / o.bucketSize));
    const end = Math.min(nBuckets, Math.ceil((b.x + b.width) / o.bucketSize));
    for (let i = start; i < end; i += 1) coverage[i] += 1;
  }

  // 窗口平均覆盖计数
  const windowBuckets = Math.max(1, Math.round(o.windowSize / o.bucketSize));
  const nWindows = Math.max(1, nBuckets - windowBuckets + 1);
  const windowCov = new Float64Array(nWindows);
  let running = 0;
  for (let i = 0; i < windowBuckets && i < nBuckets; i += 1) running += coverage[i];
  windowCov[0] = running / windowBuckets;
  for (let i = 1; i < nWindows; i += 1) {
    running += coverage[i + windowBuckets - 1] ?? 0;
    running -= coverage[i - 1];
    windowCov[i] = running / windowBuckets;
  }

  let peak = 0;
  for (let i = 0; i < nWindows; i += 1) if (windowCov[i] > peak) peak = windowCov[i];
  if (peak <= 0) return [];

  const threshold = peak * o.thresholdRatio;
  const minRun = Math.max(1, Math.round(o.minGutterWidth / o.bucketSize));
  const lowerBound = pageWidth * o.marginRatio;
  const upperBound = pageWidth * (1 - o.marginRatio);

  const splits: number[] = [];
  const candidates: Array<{ centerX: number; significance: number }> = [];
  let runStart = -1;
  for (let i = 0; i <= nWindows; i += 1) {
    const isLow = i < nWindows && windowCov[i] < threshold;
    if (isLow) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const runLength = i - runStart;
      if (runLength >= minRun) {
        const centerBucket = runStart + runLength / 2;
        const centerX = centerBucket * o.bucketSize;
        if (centerX > lowerBound && centerX < upperBound) {
          // 显著性 = 该区间内窗口覆盖率的最小值，越小越可信
          let significance = Number.POSITIVE_INFINITY;
          for (let k = runStart; k < i; k += 1) {
            if (windowCov[k] < significance) significance = windowCov[k];
          }
          candidates.push({ centerX, significance });
        }
      }
      runStart = -1;
    }
  }

  // 按显著性取前 N 条，再按位置从左到右排好
  candidates.sort((a, b) => a.significance - b.significance);
  const accepted = candidates.slice(0, Math.max(1, o.maxSplits));
  accepted.sort((a, b) => a.centerX - b.centerX);
  for (const c of accepted) splits.push(c.centerX);

  return splits;
}

/**
 * 计算一个矩形覆盖了哪几栏，返回栏序号数组（升序）。
 *
 * 判据是「矩形的 x 范围与哪几栏的 x 范围有交集」，不是拿宽度和栏宽比。
 * 早期版本用宽度比，把居中标题误判成"越栏"——标题宽 432px 小于栏宽 478px，
 * 但它从 230 横跨到 662，实际占了 2 栏。
 */
export function coveredColumnIndexes(
  box: { x: number; width: number },
  boundaries: number[]
): number[] {
  const left = box.x;
  const right = box.x + box.width;
  const result: number[] = [];
  for (let k = 0; k < boundaries.length - 1; k += 1) {
    if (left < boundaries[k + 1] && right > boundaries[k]) result.push(k);
  }
  return result;
}

/**
 * 按栏缝把文本项分栏，并就地写入 item.columnIndex。
 *
 * 分栏依据是 item 的水平中心点，因此跨栏元素会被整体归入其中心所在的那一栏。
 * 这是 I0 接受的近似：跨栏标题会被归入左栏，位置正确但阅读顺序略偏前。
 */
export function assignColumns(
  items: TextItem[],
  splits: number[],
  pageWidth: number
): ColumnLayout {
  const boundaries = [0, ...splits, pageWidth];
  const itemIdsByColumn: string[][] = boundaries.slice(0, -1).map(() => []);

  for (const item of items) {
    const centerX = item.bbox.x + item.bbox.width / 2;
    let columnIndex = boundaries.length - 2;
    for (let k = 0; k < boundaries.length - 1; k += 1) {
      if (centerX < boundaries[k + 1]) {
        columnIndex = k;
        break;
      }
    }
    item.columnIndex = columnIndex;
    itemIdsByColumn[columnIndex].push(item.id);
  }

  return { splits, boundaries, itemIdsByColumn };
}
