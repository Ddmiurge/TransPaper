import { coveredColumnIndexes } from './columns';
import { median } from './stats';
import type { BBox, Block, TextItem, TextLine } from '../types';

/**
 * 文字样式分析与「正文判定」
 *
 * ── 为什么需要这个 ──
 * 要做真正的文本重排（把 PDF 文字抽出来用 HTML 重新排版），就必须回答一个问题：
 * **哪些文字属于正文流，哪些是图表内部的标签？**
 *
 * 探测真实论文得到的关键事实：图内标签的字号通常只有正文的一半左右
 * （ResNet 论文实测：正文 14.9px，架构图内标签 7.4px）。
 * 而且正文占页面文字量的绝大部分。这两点足以做出可靠的判别。
 *
 * ── 判据 ──
 *   正文字号 = 「按字符数加权的字号众数」，不是中位数。
 *              因为正文占了绝大部分字符，众数直接落在正文上；
 *              中位数会被图内小字拉偏。
 *   正文块   = 块字号 ≥ 正文字号 × 0.85  且  块宽 ≥ 该栏宽 × 0.3
 *
 * ── 已知局限 ──
 *   pdf.js 把 fontFamily 归一化成了 sans-serif / serif / monospace，拿不到真实的
 *   "Arial-BoldMT" 这类名字，因此无法直接识别粗体。这里改用间接推断：
 *   若某个字体资源的中位字号明显大于正文字号，就认为它是标题字体（学术论文里标题通常也是粗体）。
 *   这个推断在「标题只是更大但不加粗」的论文上会误判，属于可接受的近似。
 */

export interface BlockStyle {
  /** 块内文本的主字号 */
  fontSize: number;
  /** 相对本页正文字号的倍率 */
  fontScale: number;
  /** 是否加粗（推断值） */
  bold: boolean;
  /** 0 = 正文段落，1 = 三级标题，2 = 二级标题 */
  headingLevel: number;
  /** 是否属于正文流。false 表示它属于图形区域，应整体保留为图像 */
  isBodyText: boolean;
  /** 是否送去翻译（与 isBodyText 正交，见 types.ts 的 NonTranslatableReason） */
  translatable: boolean;
  /** 不翻译的原因。null 表示可翻译 */
  nonTranslatableReason: Block['nonTranslatableReason'];
  /** 行内大间隙总次数（诊断用） */
  gapCount: number;
  /** 平均每行的大间隙次数（**仅诊断**，不作为判据，原因见判定段落注释） */
  gapsPerLine: number;
  /** 块宽 ÷ 所在栏的实际内容宽度 */
  widthRatio: number;
  /** 被排除出正文流的原因；null 表示它是正文 */
  figureReason: Block['figureReason'];
}

export interface TextStyleAnalysis {
  /** 本页正文字号 */
  bodyFontSize: number;
  /** 被判定为正文的块 id */
  bodyBlockIds: Set<string>;
  styleByBlockId: Map<string, BlockStyle>;
}

export interface TextStyleOptions {
  /**
   * 「这个矩形是否被图形触及」的探测函数。
   *
   * 只在**字号无法判定的模糊区间**内、且**逐行聚合后**才被调用（见下方判定逻辑）。
   * 注意它回答的是「一个矩形」而不是「一个块」—— 按行问、再在领域层聚合，
   * 是这里的关键设计，原因见 FIGURE_LINE_RATIO 附近的注释。
   *
   * 之所以做成注入式而非直接调用：领域层必须保持零 IO，
   * 矢量路径解析属于基础设施能力，由调用方从外部注入。
   */
  isInsideFigure?: (bbox: BBox) => boolean;
}

/** 字号低于正文字号此倍率 → 直接判为图内文字 */
const FIGURE_FONT_RATIO = 0.85;
/** 模糊区间上界：超过此倍率多半是标题，不可能在图里 */
const AMBIGUOUS_FONT_RATIO = 1.05;
/**
 * 一个块要被判为图内文字，至少要有这个比例的行被图形触及。
 *
 * ── 为什么必须按行聚合，而不是直接问整个块 ──
 * 曾经的做法是「块的包围盒是否与图形相交」。它在真实论文上立刻误判：
 * 有一页的正文因为段落切分不理想，被并成了一个 y 从 270 跨到 1069 的巨型块，
 * 它的包围盒自然与图 2 的图形相交，于是整段正文被当成图内文字保留为图像。
 *
 * 而图内标签的本质特征是「**每一行**都落在图形里」；正文段落只有边缘的
 * 一两行可能碰到图形。按行的命中比例来判，这个区别就变得极其干净：
 * 实测真图标签命中比例接近 1，而误判的大段落只有 0.03。
 */
const FIGURE_LINE_RATIO = 0.6;

/** 把字号量化到 0.5 的精度，避免浮点抖动把同一字号拆成多个桶 */
function quantize(size: number): number {
  return Math.round(size * 2) / 2;
}

export function analyzeTextStyle(
  items: TextItem[],
  lines: TextLine[],
  blocks: Block[],
  columnBoundaries: number[],
  options: TextStyleOptions = {}
): TextStyleAnalysis {
  const empty: TextStyleAnalysis = {
    bodyFontSize: 0,
    bodyBlockIds: new Set(),
    styleByBlockId: new Map(),
  };
  if (items.length === 0 || blocks.length === 0) return empty;

  // ── 1. 正文字号：按字符数加权的众数 ──
  const weightBySize = new Map<number, number>();
  for (const item of items) {
    const key = quantize(item.fontSize);
    weightBySize.set(key, (weightBySize.get(key) ?? 0) + item.str.length);
  }
  let bodyFontSize = 0;
  let bestWeight = -1;
  for (const [size, weight] of weightBySize) {
    if (weight > bestWeight) {
      bestWeight = weight;
      bodyFontSize = size;
    }
  }
  if (bodyFontSize <= 0) return empty;

  // ── 2. 每个字体资源的中位字号，用于推断标题字体（≈ 粗体）──
  const sizesByFont = new Map<string, number[]>();
  for (const item of items) {
    const list = sizesByFont.get(item.fontName) ?? [];
    list.push(item.fontSize);
    sizesByFont.set(item.fontName, list);
  }
  const headingFonts = new Set<string>();
  for (const [font, sizes] of sizesByFont) {
    if (median(sizes) >= bodyFontSize * 1.15) headingFonts.add(font);
  }

  // ── 3. 每栏的实际内容宽度 ──
  // 不能用栏边界宽度：边界含页边距（实测右栏边界 504px，而正文只有 354px 宽），
  // 会把正常标题的宽度比压到阈值以下而误杀。改用「归属本栏且不跨栏」的块的 x 并集。
  const rangeByColumn = new Map<number, { left: number; right: number }>();
  for (const block of blocks) {
    const covered = coveredColumnIndexes(block.bbox, columnBoundaries);
    if (covered.length !== 1) continue; // 跨栏块不参与
    const column = covered[0];
    const range = rangeByColumn.get(column) ?? { left: Infinity, right: -Infinity };
    range.left = Math.min(range.left, block.bbox.x);
    range.right = Math.max(range.right, block.bbox.x + block.bbox.width);
    rangeByColumn.set(column, range);
  }

  // ── 4. 逐块计算样式 ──
  const itemById = new Map(items.map((i) => [i.id, i]));
  const lineById = new Map(lines.map((l) => [l.id, l]));

  const styleByBlockId = new Map<string, BlockStyle>();
  const bodyBlockIds = new Set<string>();

  for (const block of blocks) {
    const sizes: number[] = [];
    const fontWeights = new Map<string, number>();
    /**
     * 行内「大间隙」次数。
     *
     * 这是识别图内并排标签的**辅助**特征：正文一行的文本项是连续排下来的，
     * 而图表里的标签会横向并排，同一行出现多个明显断开。
     *
     * 注意它不能当主判据 —— 正文里的行内公式同样会被 pdf.js 拆成多个文本项，
     * 实测断点/行能到 3.3。所以只用它抓极端值（见 FIGURE_GAP_PER_LINE）。
     */
    let gapCount = 0;
    let lineCount = 0;

    for (const lineId of block.lineIds) {
      const line = lineById.get(lineId);
      if (!line) continue;
      lineCount += 1;

      const lineItems: TextItem[] = [];
      for (const itemId of line.itemIds) {
        const item = itemById.get(itemId);
        if (!item) continue;
        lineItems.push(item);
        sizes.push(item.fontSize);
        fontWeights.set(item.fontName, (fontWeights.get(item.fontName) ?? 0) + item.str.length);
      }

      lineItems.sort((a, b) => a.bbox.x - b.bbox.x);
      const lineFont = median(lineItems.map((i) => i.fontSize)) || 1;
      for (let i = 1; i < lineItems.length; i += 1) {
        const prevRight = lineItems[i - 1].bbox.x + lineItems[i - 1].bbox.width;
        // 阈值取 0.3em：正文里空格是包含在文本项宽度内的，相邻项基本首尾相接，
        // 因此任何可见的水平空隙都说明这不是连续的正文排版。
        if (lineItems[i].bbox.x - prevRight > lineFont * 0.3) gapCount += 1;
      }
    }

    if (sizes.length === 0) continue;

    const fontSize = median(sizes);
    const fontScale = fontSize / bodyFontSize;

    let dominantFont = '';
    let dominantWeight = -1;
    for (const [font, weight] of fontWeights) {
      if (weight > dominantWeight) {
        dominantWeight = weight;
        dominantFont = font;
      }
    }

    /**
     * 页眉页脚里的页码 / 孤立数字。
     *
     * ── 为什么必须单独识别 ──
     * 页码的字号往往**大于**正文（实测 ResNet 第 9 页的页码 `9` 是 1.25 倍），
     * 于是字号判据把它当成标题 —— 它成了二级标题，还会被送去翻译。
     * 一个孤零零的「9」被译成中文，是排版上很显眼的错。
     *
     * 判据：整块文本只由数字（或罗马数字）构成，且很短。
     * 这个形态在论文正文里不存在，所以可以放心地特判。
     */
    const trimmed = block.text.trim();
    const looksLikePageNumber =
      /^\d{1,4}$/.test(trimmed) || /^[ivxlcdm]{1,6}$/i.test(trimmed);

    let headingLevel = 0;
    // 页码不是标题 —— 先排除它，再判标题级别
    if (!looksLikePageNumber) {
      if (fontScale >= 1.3) headingLevel = 2;
      else if (fontScale >= 1.06) headingLevel = 1;
    }

    const range = rangeByColumn.get(block.columnIndex);
    const columnWidth = range ? Math.max(1, range.right - range.left) : block.bbox.width;
    const widthRatio = block.bbox.width / columnWidth;

    // ── 判定 ──
    // 主判据：字号。学术论文里图内标签通常显著小于正文（实测 0.33–0.79 倍）。
    //
    // 注意这里**没有**用 gapsPerLine 做判据。它原本被寄予厚望（「图内标签会横向并排，
    // 同一行多个断开」），但实测数据把它证否了：真实正文的断点/行能到 3.3
    // （因为 pdf.js 会把行内公式 `F(x)` 拆成 4 个文本项），而图内标签大量是 0.0。
    // 两个分布几乎完全重叠，用它判别只会同时产生误杀和漏判。
    // 保留该字段纯粹是为了诊断时观察。
    const gapsPerLine = lineCount > 0 ? gapCount / lineCount : 0;
    const fontOk = fontScale >= FIGURE_FONT_RATIO;

    // 宽度判据只用于普通段落。标题天然短，用宽度卡它必然误杀
    // （实测 `4. Experiments` 宽比只有 0.31，但它是标题不是图标签）。
    const widthOk = headingLevel > 0 || widthRatio >= 0.35;

    // 补刀：只在字号落入模糊区间、且宽度判据放行时才问「有多少行落在图形里」。
    // 区间外（明显更小 = 图内文字；明显更大 = 标题）不问，避免探测函数的不确定性
    // 污染本来可以靠字号干净判定的那部分。
    const ambiguous = fontOk && fontScale <= AMBIGUOUS_FONT_RATIO;
    let figureLineRatio = 0;
    if (ambiguous && widthOk && options.isInsideFigure) {
      let inside = 0;
      for (const lineId of block.lineIds) {
        const line = lineById.get(lineId);
        if (line && options.isInsideFigure(line.bbox)) inside += 1;
      }
      figureLineRatio = lineCount > 0 ? inside / lineCount : 0;
    }
    const inFigure = figureLineRatio >= FIGURE_LINE_RATIO;

    const isBodyText = fontOk && widthOk && !inFigure;

    let figureReason: Block['figureReason'] = null;
    if (!isBodyText) {
      if (!fontOk) figureReason = 'font-size';
      else if (inFigure) figureReason = 'graphics-region';
      else figureReason = 'narrow';
    }

    const style: BlockStyle = {
      fontSize,
      fontScale: Number(fontScale.toFixed(3)),
      bold: headingFonts.has(dominantFont),
      headingLevel,
      isBodyText,
      // 页码不翻译。参考文献的判定要跨页，放在 analyzePage 里做（见 references.ts）
      translatable: !looksLikePageNumber,
      nonTranslatableReason: looksLikePageNumber ? 'numeric' : null,
      gapCount,
      gapsPerLine: Number(gapsPerLine.toFixed(2)),
      widthRatio: Number(widthRatio.toFixed(2)),
      figureReason,
    };

    styleByBlockId.set(block.id, style);
    if (isBodyText) bodyBlockIds.add(block.id);
  }

  return { bodyFontSize, bodyBlockIds, styleByBlockId };
}

/**
 * 用「仍然正文的块」重算正文字号，并刷新所有正文块的字号倍率与标题级别。
 *
 * ── 为什么需要二次计算 ──
 * 初次计算（analyzeTextStyle）按「字符数加权的字号众数」取正文字号，
 * 前提是正文占页面字符量的大头。在图表占绝大多数的页面上这个前提会破：
 * 一旦 remarkBodyBlocksInsideRegions 把图内标签成批地移出正文流，
 * 剩下真正文才是可靠的字号来源。用它们重算一遍，
 * 初次判定里被错误放大/缩小的字号倍率（用户看到的就是
 * 「附录里有些字特别大」）就一起被纠正了。
 *
 * 没有正文块可用的页面（纯图页）保持原值不动。
 */
export function refineBodyFontSize(blocks: Block[], style: TextStyleAnalysis): void {
  const bodyBlocks = blocks.filter((b) => b.isBodyText && b.text.length > 0);
  if (bodyBlocks.length === 0) return;

  const weightBySize = new Map<number, number>();
  for (const block of bodyBlocks) {
    const key = quantize(block.fontSize);
    weightBySize.set(key, (weightBySize.get(key) ?? 0) + block.text.length);
  }
  let bodyFontSize = 0;
  let bestWeight = -1;
  for (const [size, weight] of weightBySize) {
    if (weight > bestWeight) {
      bestWeight = weight;
      bodyFontSize = size;
    }
  }
  if (bodyFontSize <= 0) return;

  style.bodyFontSize = bodyFontSize;
  for (const block of blocks) {
    if (!block.isBodyText) continue;
    block.fontScale = Number((block.fontSize / bodyFontSize).toFixed(3));
    // 标题级别跟随新倍率重算 —— 初次判定用的是被污染的基准，
    // 图表页上「正文的 2 倍」可能只是字号基准算小了，不是真标题
    block.headingLevel = block.fontScale >= 1.3 ? 2 : block.fontScale >= 1.06 ? 1 : 0;
  }
}
