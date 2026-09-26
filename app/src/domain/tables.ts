import type { Block, BBox, TextItem, TextLine } from '../types';

/**
 * 文字表格识别 —— 把「纯文字排版的表格」从正文流里认出来。
 *
 * ── 为什么需要它 ──
 * ACL / NeurIPS 这类排版的表格不是嵌入图片、也常没有足够的矢量线框，
 * 而是**一行行正文号文字**，列与列之间靠空白分隔。现有管线会把它们当成
 * 普通段落重排 —— 行列结构全部丢失，读起来是一串「数字汤」。
 * R3 的原始需求就是「表格保持原样不翻译」，这些表格目前是唯一漏网的非文本元素。
 *
 * ── 为什么在「行」级别判定 ──
 * 表格行的语料特征与正文几乎一致（同字号、同栏），块级判据分不出来。
 * 但表格行有一个正文没有的几何特征：**一行里有多个大间隙**（单元格分隔），
 * 且这些间隙的横向位置**跨行对齐**（共享列边界）。
 * 「as shown in Table 3」这类正文行最多有一个稍大的空格，凑不齐这两条。
 *
 * ── 阈值全部来自真实数据标定（ACL 样本 p6/p14/p15/p16，body=17px）──
 *   - 单元格间隙：ACL 表格列间隙 ≥ 1.0 × 正文字号（实测 60–170px），
 *     正文词间隙只有 0.2–0.4 × —— 阈值取 1.0 × 正文字号（且不低于 12px）。
 *   - 行距：同一张表的相邻行距实测 10–30px（0.6–1.76 ×），
 *     不同表之间隔着图注/正文，远大于此 —— 阈值取 2.0 × 正文字号。
 *   - 列边界跨行容差：同一列的间隙中心跨行波动 ≤ 14px（实测）—— 取 16px。
 *   - 最少行数：3（表头 + 至少两行数据；两行的「表」宁可漏判）。
 *
 * ── 防误报的三道闸（实测迭代出来，别凭直觉改）──
 *   1. **块级排除**：公式块、文献/作者/页码（nonTranslatableReason）、标题不参选。
 *      注意**不要求 isBodyText**——ACL 的表格用小字号（实测 0.38–0.57 ×），
 *      行早已被字号判据标成「图内文字」（body=false），要求正文反而会全军覆没。
 *   2. **长词密度**：真表格行的文字几乎不含 ≥3 字母的英文单词
 *      （实测 ACL 全部表格平均 0.75–3 个/行），而「正文 + 行尾行内公式 /
 *      绕排图基线上混入的标签」这类假候选每行有 7–9 个（实测单栏样本 p6
 *      的正文段落误报）。判据：组内 ≤4 个长词的行占比 ≥60%，且组平均 ≤4。
 *   3. **≥3 行连续成组 + 共享列边界**：孤立的大间隙行凑不够行数；
 *      表格的列边界是跨行对齐的，正文里凑不出来。
 */

/** 一个识别出的文字表格区域 */
export interface TableRegion {
  /** 表格的整体包围盒（视口坐标） */
  bbox: BBox;
  /** 构成表格的行 id（按阅读顺序） */
  lineIds: string[];
}

export interface TableDetectOptions {
  /** 行内「单元格间隙」的最小宽度（px） */
  cellGap: number;
  /** 相邻两行纵向间距小于此值才算同一张表（px） */
  rowGap: number;
  /** 成表的最少行数 */
  minRows: number;
  /** 共享列边界需要覆盖的行数比例 */
  sharedBoundaryRatio: number;
  /** 列边界聚类的容差（px） */
  boundaryTol: number;
}

const DEFAULTS: TableDetectOptions = {
  cellGap: 0,
  rowGap: 0,
  minRows: 3,
  sharedBoundaryRatio: 0.6,
  boundaryTol: 16,
};

export function detectTableRegions(
  lines: TextLine[],
  items: TextItem[],
  bodyFontSize: number,
  blocks: Block[],
  options: Partial<TableDetectOptions> = {}
): TableRegion[] {
  if (lines.length === 0 || bodyFontSize <= 0) return [];
  // cellGap / rowGap 依赖正文字号，在入口统一算好（允许调用方覆盖以便测试）
  const o: TableDetectOptions = {
    ...DEFAULTS,
    cellGap: Math.max(bodyFontSize * 1.0, 12),
    rowGap: bodyFontSize * 2.0,
    ...options,
  };

  const itemById = new Map(items.map((i) => [i.id, i]));
  const blockByLine = new Map<string, Block>();
  for (const block of blocks) {
    for (const lineId of block.lineIds) blockByLine.set(lineId, block);
  }

  /** 这一行是否可能是表格行（第一道闸：块级排除；不要求 isBodyText，见头注） */
  const isCandidate = (line: TextLine): boolean => {
    const block = blockByLine.get(line.id);
    if (!block) return false;
    // 公式、文献、作者、页码 —— 各有归宿，不参与表格判定
    if (block.formula || block.nonTranslatableReason || block.headingLevel > 0) return false;
    return true;
  };

  /** ≥3 字母的英文单词数。表格行极少，正文行很多（第二道闸的原料） */
  const longWordsOf = (line: TextLine): number =>
    (line.text.match(/[A-Za-z]{3,}/g) ?? []).length;

  /** 行内「单元格间隙」的中心 x（间隙宽度 ≥ cellGap 才算） */
  const gapCentersOf = (line: TextLine): number[] => {
    const its = line.itemIds
      .map((id) => itemById.get(id))
      .filter((i): i is TextItem => Boolean(i))
      .sort((a, b) => a.bbox.x - b.bbox.x);
    if (its.length < 3) return [];
    const centers: number[] = [];
    for (let i = 1; i < its.length; i += 1) {
      const gap = its[i].bbox.x - (its[i - 1].bbox.x + its[i - 1].bbox.width);
      if (gap >= o.cellGap) {
        centers.push(its[i - 1].bbox.x + its[i - 1].bbox.width + gap / 2);
      }
    }
    return centers;
  };

  // 每栏独立聚组：不同栏的行不可能属于同一张表
  const byColumn = new Map<number, Array<{ line: TextLine; gaps: number[] }>>();
  for (const line of lines) {
    if (!isCandidate(line)) continue;
    const gaps = gapCentersOf(line);
    if (gaps.length < 2) continue; // 至少 3 个单元格
    const list = byColumn.get(line.columnIndex) ?? [];
    list.push({ line, gaps });
    byColumn.set(line.columnIndex, list);
  }

  /** 组内是否真的是表格（第二、三道闸） */
  const groupIsTable = (group: Array<{ line: TextLine; gaps: number[] }>): boolean => {
    // 第二道闸：长词密度。表格行几乎不含英文长词；混进来的正文行一票否决不了
    // 就用占比 —— 表头（如 `Method ASR-M GHR HD …`）允许词多，但最多占 40%。
    const words = group.map((g) => longWordsOf(g.line));
    const sparse = words.filter((w) => w <= 4).length;
    if (sparse < group.length * 0.6) return false;
    const avg = words.reduce((s, w) => s + w, 0) / words.length;
    if (avg > 4) return false;

    // 第三道闸：共享列边界。所有行的间隙中心聚成簇，
    // 至少一个簇覆盖 ≥60% 的行（且 ≥2 行）—— 列边界是跨行对齐的。
    const centers = group.flatMap((g) => g.gaps).sort((a, b) => a - b);
    let best = 0;
    let i = 0;
    while (i < centers.length) {
      let j = i;
      while (j + 1 < centers.length && centers[j + 1] - centers[j] <= o.boundaryTol) j += 1;
      best = Math.max(best, j - i + 1);
      i = j + 1;
    }
    return best >= Math.max(2, Math.ceil(group.length * o.sharedBoundaryRatio));
  };

  const makeRegion = (group: Array<{ line: TextLine }>): TableRegion => {
    const x0 = Math.min(...group.map((g) => g.line.bbox.x));
    const y0 = Math.min(...group.map((g) => g.line.bbox.y));
    const x1 = Math.max(...group.map((g) => g.line.bbox.x + g.line.bbox.width));
    const y1 = Math.max(...group.map((g) => g.line.bbox.y + g.line.bbox.height));
    return {
      // 纵向稍扩：行 bbox 只到字形附近，上下各留 0.25 行高，切片不切掉字帽字脚
      bbox: {
        x: x0 - 2,
        y: y0 - bodyFontSize * 0.25,
        width: x1 - x0 + 4,
        height: y1 - y0 + bodyFontSize * 0.5,
      },
      lineIds: group.map((g) => g.line.id),
    };
  };

  const regions: TableRegion[] = [];
  for (const candidates of byColumn.values()) {
    candidates.sort((a, b) => a.line.bbox.y - b.line.bbox.y);
    let group: Array<{ line: TextLine; gaps: number[] }> = [];
    const flush = () => {
      if (group.length >= o.minRows && groupIsTable(group)) {
        regions.push(makeRegion(group));
      }
      group = [];
    };
    let prevY = -Infinity;
    for (const entry of candidates) {
      if (group.length > 0 && entry.line.bbox.y - prevY > o.rowGap) flush();
      group.push(entry);
      prevY = entry.line.bbox.y;
    }
    flush();
  }
  return regions;
}
