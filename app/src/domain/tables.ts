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

/**
 * 表格题注的固定英文格式（`Table 3.` / `TABLE IV` / `Fig. 2`）。
 *
 * 表头收编时用来排除题注 —— 题注紧贴表格上方、横向几乎全宽重叠、字号同正文，
 * 几何上和表头几乎无法区分，但它**必须继续可译**（题注是正文的一部分）。
 */
const CAPTION_RE = /^(table|tab\.?|tbl\.?|figure|fig\.?)\s*[0-9IVXivx]+[.:)]?\s/i;

/** ≥3 字母的英文单词数。表格行极少，正文行很多（长词密度闸的原料） */
function longWordsOf(line: TextLine): number {
  return (line.text.match(/[A-Za-z]{3,}/g) ?? []).length;
}

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

  /** ≥3 字母的英文单词数。表格行极少，正文行很多（第二道闸的原料）。
   *  实现见模块级 `longWordsOf`（表头收编也要用同一把尺）。 */

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

  // 顺序要紧：**先收表头，再跨栏合并**。
  // 表头行横跨中缝（分属两栏、各自只占一半），先并进各自区域后，
  // 左右两块才带上共同的表头行 —— 合并时的「行距节奏一致」判据才能成立。
  // 反过来（先合并）时，合并出的区域上沿已是数据行顶边，表头判据量不到。
  const withHeaders = regions.map((r) => adoptHeaderRows(r, lines, bodyFontSize, isCandidate));
  return mergeCrossColumn(withHeaders, lines, bodyFontSize);
}

/**
 * 把「表头行」并入它下方的表格区域。
 *
 * ── 为什么表头会漏 ──
 * 表格的**列名行**（`Optimization Positional Method`、`Cost (mins.) Sensitivity (↓)`）
 * 往往横跨中缝、且单元格之间靠文字本身的空格而非大间隙分隔，
 * `gapCentersOf` 数不出 ≥2 个间隙 → 永远进不了候选 → 被 `paragraphBuilder`
 * 当成普通正文抽走。结果切片里只剩数据行，表头凭空消失、列对不上（I28 修复）。
 *
 * ── 纳入判据（保守：三条全中才纳入，宁可留正文也不误吞）──
 *  1. **紧邻**：位于区域顶边上方一行高以内（表头与首行数据贴得很近）；
 *  2. **横向重叠**：与区域 x 区间有实质重叠（同一张表，不是隔壁的段落）；
 *  3. **字号相仿**：字号与正文字号的比值在表头常见区间内（0.6–1.3），
 *     且长词数少（表头多为短词/缩写）—— 挡住「表上方那段正常正文」。
 */
function adoptHeaderRows(
  region: TableRegion,
  lines: TextLine[],
  bodyFontSize: number,
  isCandidate: (line: TextLine) => boolean
): TableRegion {
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const own = new Set(region.lineIds);
  const ownRows = region.lineIds
    .map((id) => lineById.get(id))
    .filter((l): l is TextLine => Boolean(l))
    .sort((a, b) => a.bbox.y - b.bbox.y);

  const dataTop = ownRows.length > 0 ? Math.min(...ownRows.map((l) => l.bbox.y)) : region.bbox.y;
  const rLeft = region.bbox.x;
  const rRight = region.bbox.x + region.bbox.width;
  const rWidth = Math.max(1, rRight - rLeft);
  const gapH = bodyFontSize * 2.6; // 表头与首行数据行的最大间距
  const headerRows: TextLine[] = [];

  for (const line of lines) {
    if (own.has(line.id) || !isCandidate(line)) continue;
    // 1. 位于区域上方、且距离在表头常见间距内
    const above = dataTop - (line.bbox.y + line.bbox.height);
    if (above < -2 || above > gapH) continue;
    // 2. 与区域横向**大幅**重叠（≥ 区域宽的 40%）。
    //    这条挡的是 ResNet 那种「图内标签恰好在表格上方」的误并 ——
    //    标签通常只占表格宽度的一小段，重叠不足就会排除。
    const lRight = line.bbox.x + line.bbox.width;
    const overlap = Math.min(rRight, lRight) - Math.max(rLeft, line.bbox.x);
    if (overlap / rWidth < 0.4) continue;
    // 3. 字号相仿（表头不是小字号的图内标签，也不是大字号标题）
    const ratio = line.bbox.height / bodyFontSize;
    if (ratio < 0.55 || ratio > 1.45) continue;
    // 4. **排除表格题注**。题注（`Table 3. Error rates (%, …) on ImageNet validation`）
    //    紧贴表格上方、重叠几乎 100%、字号与正文相同 —— 前三条全过，
    //    但它是**要翻译的正文**（ResNet p6 实测被误吞的就是它）。
    //    题注有固定英文格式，靠这一条挡住；表格题注另有专门的免译处理（ADR-012）。
    if (CAPTION_RE.test(line.text)) continue;
    // 5. **长词密度**：表头是短词/数字/缩写（`top-1 err.`、`PPL`、`GCG 6N`），
    //    而「表格上方的一整句说明」（`VGG-16 is based on our test. ResNet-50/101/152…`）
    //    长词密集 —— 它是表格脚注而非表头。复用 groupIsTable 的同一把尺（≤4）。
    //    ResNet p6 实测：正是这两行说明被误收，使题注块被区域覆盖 68% 而丢失。
    if (longWordsOf(line) > 4) continue;
    headerRows.push(line);
  }

  if (headerRows.length === 0) return region;
  // 表头行数上限：表头最多两行（主表头 + 子表头）。超过说明这是一段正文被
  // 误判成表头，宁可放弃也不把正文吞进表格。
  if (headerRows.length > 2) return region;
  headerRows.sort((a, b) => a.bbox.y - b.bbox.y);
  const all = [...headerRows, ...ownRows];
  const x0 = Math.min(...all.map((l) => l.bbox.x));
  const y0 = Math.min(...all.map((l) => l.bbox.y));
  const x1 = Math.max(...all.map((l) => l.bbox.x + l.bbox.width));
  const y1 = Math.max(...all.map((l) => l.bbox.y + l.bbox.height));

  // 上沿不得越过「被排除的题注行」。ResNet p6 实测：`Table 3. Error rates…`
  // 这行题注被 CAPTION_RE 正确排除在 lineIds 之外，但它紧贴表格上方 ——
  // 若 bbox 照抄表头行的上沿，就会把这条**仍需翻译**的题注框进表格区域，
  // 使它在渲染层被判为图内文字而丢失。
  const headerIds = new Set(headerRows.map((l) => l.id));
  const captionGuard = lines
    .filter((l) => !own.has(l.id) && !headerIds.has(l.id) && CAPTION_RE.test(l.text))
    .filter((l) => l.bbox.y + l.bbox.height <= y0)
    .map((l) => l.bbox.y + l.bbox.height)
    .sort((a, b) => b - a)[0];

  const top = Math.max(y0 - bodyFontSize * 0.25, captionGuard ?? -Infinity);
  return {
    bbox: {
      x: x0 - 2,
      y: top,
      width: x1 - x0 + 4,
      height: y1 - top,
    },
    lineIds: [...headerRows.map((l) => l.id), ...region.lineIds],
  };
}

/**
 * 跨栏表格合并（Eyes-on-Me Table 5 踩到的坑）。
 *
 * ── 为什么需要它 ──
 * 上面按 `columnIndex` 分组的前提是「不同栏的行不可能属于同一张表」。
 * 但**横跨双栏的表**（NeurIPS 双栏里常见的全宽表）恰好违反它：
 * 它的数据行确实分属左右两栏（各自被当成一张独立的表），
 * 而横跨中缝的**表头行**只有 0–1 个单元格间隙，永远过不了「≥2 间隙」的闸，
 * 于是全部漏判成正文 —— 结果切片把左右两块连起来，表头却已被抽走，
 * 表格错位（实测 Eyes-on-Me p8 Table 5：表头 `Optimization Positional Method`、
 * `Cost (mins.) Sensitivity (↓)` 判成可译正文）。
 *
 * ── 合并判据（三个信号都必须满足，宁可漏合不可错合）──
 *  1. **纵向区间重叠**：两区域 y 区间相交（各留 0.25 行高的容差）。
 *     双栏里两张真正独立的表上下分开，不会相交。
 *  2. **横向分离**：两半左右并排、x 区间重叠 ≤ 各自宽度的 30%。
 *     真实横表跨中缝并排；同栏上下两张表 x 重合（单元测试守护用例）。
 *  3. **行距节奏一致**：左右两半的行 y 逐行严格重合（容差 1.5px）。
 *     这是横表最强信号 —— 同一张表的各行横跨中缝对齐排布。
 *
 * 合并后 bbox 取并集（覆盖中缝整幅），这样切片是一张完整表而不是两块。
 */
function mergeCrossColumn(
  regions: TableRegion[],
  lines: TextLine[],
  bodyFontSize: number
): TableRegion[] {
  if (regions.length < 2) return regions;

  const lineById = new Map(lines.map((l) => [l.id, l]));
  /** 区域的行 y 序列（升序） */
  const ysOf = (r: TableRegion): number[] =>
    r.lineIds
      .map((id) => lineById.get(id)?.bbox.y)
      .filter((y): y is number => typeof y === 'number')
      .sort((a, b) => a - b);

  /**
   * 行距节奏是否一致 —— 判定「左右两半属于同一张横表」。
   *
   * 横表最强信号：左右两半的行 y **逐行严格重合**（实测 Eyes-on-Me p8
   * Table 5 两侧都是 173/188/203/223/238，偏差 0px）。同栏上下两张
   * 碰巧行距相同的独立表（单元测试「不同栏的相同网格各自成表」）行距也一致，
   * 但它们的行**不是逐行对齐**的 —— 所以这里必须逐行比对而非只比间距集合。
   *
   * 规则：两半行数相同，且逐行 y 偏差 ≤ ROW_ALIGN_TOL。
   * 收表头后两侧表头行数可能不等 —— 允许一侧多出「纯表头行」（它下面
   * 的数据行仍逐行对齐），但数据行主体必须严格重合。
   */
  const ROW_ALIGN_TOL = 1.5;
  const rhythmMatches = (a: number[], b: number[]): boolean => {
    if (a.length < 2 || b.length < 2) return false;
    // 以较长的序列为基准，逐行找对齐；短序列至少要覆盖基准的多数行
    const [long, short] = a.length >= b.length ? [a, b] : [b, a];
    let aligned = 0;
    let si = 0;
    for (let i = 0; i < long.length; i += 1) {
      // 在短序列里找与 long[i] 对齐的行（容差内），保持单调推进
      let found = -1;
      for (let j = si; j < short.length; j += 1) {
        if (Math.abs(short[j] - long[i]) <= ROW_ALIGN_TOL) {
          found = j;
          break;
        }
      }
      if (found >= 0) {
        aligned += 1;
        si = found + 1;
      }
    }
    // 至少 2 行严格对齐，且覆盖长序列的多数（表头可能只在一侧）
    return aligned >= 2 && aligned >= Math.ceil(long.length * 0.6);
  };

  const merged: TableRegion[] = [];
  const used = new Set<number>();
  for (let i = 0; i < regions.length; i += 1) {
    if (used.has(i)) continue;
    let acc = regions[i];
    used.add(i);
    // 与后续区域两两尝试合并（可能一条带横跨多栏，如三栏表）
    for (let j = i + 1; j < regions.length; j += 1) {
      if (used.has(j)) continue;
      const other = regions[j];
      const overlapY =
        Math.min(acc.bbox.y + acc.bbox.height, other.bbox.y + other.bbox.height) -
          Math.max(acc.bbox.y, other.bbox.y) >
        -bodyFontSize * 0.25;
      if (!overlapY) continue;
      // 2. **横向分离**：两半必须左右并排（真实横表跨中缝，x 区间基本不重叠）。
      //    这条挡掉「同一位置、不同栏标记」的情况（单元测试「不同栏的相同网格
      //    各自成表」两半 x 完全重合 —— 那是两张上下独立的表，不是横跨的一张）。
      const xOverlap =
        Math.min(acc.bbox.x + acc.bbox.width, other.bbox.x + other.bbox.width) -
        Math.max(acc.bbox.x, other.bbox.x);
      const minWidth = Math.min(acc.bbox.width, other.bbox.width);
      if (xOverlap > minWidth * 0.3) continue;
      if (!rhythmMatches(ysOf(acc), ysOf(other))) continue;
      const x0 = Math.min(acc.bbox.x, other.bbox.x);
      const y0 = Math.min(acc.bbox.y, other.bbox.y);
      const x1 = Math.max(acc.bbox.x + acc.bbox.width, other.bbox.x + other.bbox.width);
      const y1 = Math.max(acc.bbox.y + acc.bbox.height, other.bbox.y + other.bbox.height);
      acc = {
        bbox: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
        lineIds: [...acc.lineIds, ...other.lineIds],
      };
      used.add(j);
    }
    merged.push(acc);
  }
  return merged;
}
