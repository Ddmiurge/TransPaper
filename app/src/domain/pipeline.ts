import { assignColumns, detectColumnSplits, type ColumnDetectOptions } from './columns';
import {
  expandRegionsToText,
  figureClusters,
  remarkBodyBlocksInsideRegions,
  type FigureRegionOptions,
} from './figureRegions';
import { buildParagraphs, groupIntoLines, type ParagraphBuildOptions } from './paragraphBuilder';
import { markFormulas } from './formulas';
import { markReferences } from './references';
import { markFrontMatter } from './frontMatter';
import { detectTableRegions } from './tables';
import { coverageRatio, mergeOverlapping, unionBBox } from './bbox';
import { analyzeTextStyle, refineBodyFontSize, type TextStyleOptions } from './textStyle';
import type { BBox, Block, PageAnalysis, TextItem, TextLine } from '../types';

export interface AnalyzeOptions {
  column?: Partial<ColumnDetectOptions>;
  paragraph?: Partial<ParagraphBuildOptions>;
  /**
   * 本页的矢量路径包围盒（由 pdf 层提取）。
   *
   * analyzePage 用它们聚类出「图形区域」—— 这是**唯一一处**计算：
   * 图内文字判定、跨栏裁切、被切分自检全部复用它。让调用方各算一遍迟早漂移。
   */
  rawPaths?: BBox[];
  /**
   * 本页的**位图**放置框（嵌入图片，由 pdf 层提取）。
   *
   * 图表以整张图片嵌入时矢量路径为 0（实测 ACL 排版），只看 rawPaths
   * 等于对这类论文关闭图表检测。每个足够大的位图框直接作为图形区域候选，
   * 不参与聚类、也不受 MIN_PATHS_PER_FIGURE 约束 ——
   * 「一张嵌入的大图」本身就是图形，不需要同伴。
   */
  rawImages?: BBox[];
  /** 图形聚类的可调参数 */
  figureCluster?: Partial<FigureRegionOptions>;
  /**
   * 「该矩形是否被图形触及」的探测函数。见 textStyle.ts 的 TextStyleOptions。
   * 由调用方注入，领域层本身不依赖像素与 pdf.js。
   */
  isInsideFigure?: TextStyleOptions['isInsideFigure'];
  /**
   * 进入本页之前，文档是否已处于参考文献区间。
   *
   * 文献表常从某页的栏末开始、下一页继续，所以必须由调用方逐页串联：
   * 把上一页返回的 `PageAnalysis.referencesActive` 传进来。
   */
  referencesActive?: boolean;
}

export interface AnalyzeInput {
  pageIndex: number;
  width: number;
  height: number;
  items: TextItem[];
  options?: AnalyzeOptions;
}

/** 图形路径数量达到此值才认为构成一个图形区域 */
const MIN_PATHS_PER_FIGURE = 4;
/** 位图要成为图形区域候选的最小边长（视口 px）。更小的是图标/装饰，不是图表 */
const MIN_IMAGE_DIMENSION = 40;
/** 位图面积占页面积超过此比例视为**整页背景**——不能把整页判成图，否则正文全灭 */
const MAX_IMAGE_PAGE_RATIO = 0.85;
/**
 * 图内文字与图形边缘的最大间距（px）—— 超过就不算「在图里」。
 *
 * 取值依据实测：第 4 页图 3 的第一行标签 `output size: 224` 底边在 y≈166，
 * 而矢量路径从 y=182 才开始 —— 中间隔了 16px 的空白（文字与第一个方框之间的间隙）。
 * 8px 因此够不着，图顶那一段仍会漏在图形区域之外。
 *
 * 放宽到 24px 是安全的：并入的前提是字号 ≤ 0.6 倍正文，
 * 正文（1.0 倍）与图注（0.9 倍）都被排除在外，不会连正文一起吞进来。
 */
const FIGURE_TEXT_PAD = 24;
/**
 * 并入图形区域的文字字号上限（相对正文）。
 *
 * 取值要在两个真实样本之间留出余量：
 *   - **要并入**：图 3 的列标题 `VGG-19 / 34-layer plain / 34-layer residual`
 *     实测 0.79 倍正文 —— 它在图内，却比典型图标签（0.33–0.66 倍）大不少
 *   - **不能并入**：图注 `Figure 3. …` 实测 0.90 倍正文 —— 它在图的**外面**，
 *     一旦并进来，图形区域会顺着图注继续吞掉后面的正文
 *
 * 0.85 落在两者之间，两侧各留约 0.05 的余量。
 */
const FIGURE_TEXT_MAX_FONT_RATIO = 0.85;

/**
 * 单页分析流水线：文本项 → 分栏 → 行 → 段落 → 文字样式 → 翻译单元。
 *
 * 纯函数，不依赖 DOM 与 pdf.js，因此可以在 Node 里离线校验（见 scripts/verify:pdf）。
 *
 * 阅读顺序编码：readOrder = columnIndex * 10000 + 段序号。
 * 这样"左栏读到底再读右栏"天然成立，且栏数变化时不会冲突。
 */
export function analyzePage(input: AnalyzeInput): PageAnalysis {
  const { pageIndex, width, height, items, options = {} } = input;

  // 旋转文字（图的纵轴标签、arXiv 竖排侧标）在**成行之前**就剔除。
  //
  // 不能等到判定阶段再标记：groupIntoLines 用基线聚类，旋转文字的基线会与相邻正文行
  // 相近，于是两者被并进同一行、同一个块 —— 实测第 1 页的侧标与正文粘成了
  // `arXiv:1512.03385v1 [cs.CV] 10 Dec 2015Deep convolutional neural networks [22, 21]`。
  // 一旦粘上，后面无论怎么判都会连带把正文一起判掉，或反过来把正文整段保留成图像。
  //
  // 剔除后它们所在的区域交给图像切片覆盖 —— 这正是「非文本内容保持原样」的做法。
  const flowItems = items.filter((i) => !i.rotated);

  const columnSplits = detectColumnSplits(
    flowItems.map((i) => ({ x: i.bbox.x, width: i.bbox.width })),
    width,
    options.column
  );

  const layout = assignColumns(flowItems, columnSplits, width);

  const lines: TextLine[] = [];
  const blocks: Block[] = [];

  const columnCount = layout.boundaries.length - 1;
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const columnItems = flowItems.filter((i) => i.columnIndex === columnIndex);
    if (columnItems.length === 0) continue;
    const columnLines = groupIntoLines(columnItems, options.paragraph);
    lines.push(...columnLines);
    blocks.push(...buildParagraphs(columnLines, pageIndex, options.paragraph));
  }

  // 保证全局有序：先按栏，再按段序号（readOrder 已编码）
  blocks.sort((a, b) => a.readOrder - b.readOrder);

  // 文字样式分析：判定哪些块属于正文流（可重排为 HTML），哪些属于图形区域（保留为图像）
  const style = analyzeTextStyle(flowItems, lines, blocks, layout.boundaries, {
    isInsideFigure: options.isInsideFigure,
  });
  for (const block of blocks) {
    const s = style.styleByBlockId.get(block.id);
    if (!s) continue;
    block.fontSize = s.fontSize;
    block.fontScale = s.fontScale;
    block.bold = s.bold;
    block.headingLevel = s.headingLevel;
    block.isBodyText = s.isBodyText;
    block.widthRatio = s.widthRatio;
    block.gapsPerLine = s.gapsPerLine;
    block.figureReason = s.figureReason;
    // 页码这类「保留为文本但不翻译」的判定在 textStyle 里做；
    // 参考文献要跨页判区间，放在下面单独处理
    block.translatable = s.translatable;
    block.nonTranslatableReason = s.nonTranslatableReason;
  }

  // 参考文献区间：从 `References` 标题起、到下一个真标题止，整段不翻译。
  // 必须在 blocks 已按阅读顺序排好之后调用（上面第 103 行已排过序）。
  const referencesActive = markReferences(blocks, options.referencesActive ?? false);

  // 行间公式：编号 + 数学符号密度判定。必须在 markReferences 之后 ——
  // 参考文献里的公式符号密度也可能很高（期刊卷号、页码区间），
  // 已被标为不翻译的块这里直接跳过，归属清晰。
  markFormulas(blocks);

  // 首页 front-matter（标题 / 作者 / 机构 / 邮箱）：标题与摘要之间的块免译。
  // 放在最后：它只动首页、且只把区间内块标成 'authors'，不会与上面三者冲突
  // （作者块不在参考文献区间、不是公式、也不是页码）。
  markFrontMatter(blocks, height);

  // ── 文字表格识别（I17）──
  //
  // ACL / NeurIPS 式排版里表格是「正文号文字 + 列间隙」，
  // 字号判据与矢量路径都够不着它，是 R3「表格保持原样」最后漏网的非文本元素。
  // 判据与防误报闸门见 tables.ts —— 必须在 markFormulas / markReferences /
  // markFrontMatter 之后调用：候选行要靠这些标记过滤掉公式/文献/作者行。
  const tableRegions = detectTableRegions(lines, items, style.bodyFontSize, blocks);
  const tableBoxes = tableRegions.map((r) => r.bbox);
  for (const block of blocks) {
    if (!block.isBodyText || block.formula) continue;
    const covered = tableBoxes.some((r) => coverageRatio(block.bbox, r) >= 0.5);
    if (!covered) continue;
    block.isBodyText = false;
    block.figureReason = 'table-region';
    block.translatable = false;
  }

  // 图形区域：路径聚类 → 扩展到包住图内文字。
  //
  // 扩展这一步是修「图被上下截成两段还错位」的关键：矢量路径不覆盖图内的文字标签，
  // 缺口恰好落在图的顶部/底部，那一段会被当成栏内空隙、生成一个**整栏宽**的切片，
  // 与图主体的宽度不同，缩放后居中位置也就不同。
  // 位图候选：尺寸过滤 + 裁剪到页面内 + 排除整页背景
  const pageArea = width * height;
  const imageRegions = (options.rawImages ?? [])
    .map((box) => {
      const x0 = Math.max(0, box.x);
      const y0 = Math.max(0, box.y);
      const x1 = Math.min(width, box.x + box.width);
      const y1 = Math.min(height, box.y + box.height);
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    })
    .filter(
      (b) =>
        b.width >= MIN_IMAGE_DIMENSION &&
        b.height >= MIN_IMAGE_DIMENSION &&
        (b.width * b.height) / pageArea <= MAX_IMAGE_PAGE_RATIO
    );

  // 位图框与路径簇可能描述同一个图（位图图表 + 矢量坐标轴），
  // 重叠的区域先合并，否则会产出两片互相重叠的切片
  const regionCandidates = mergeOverlapping([
    ...figureClusters(options.rawPaths ?? [], options.figureCluster)
      .filter((c) => c.pathCount >= MIN_PATHS_PER_FIGURE)
      .map((c) => c.bbox),
    ...imageRegions,
    // 表格矩形并入区域集合：与矢量簇/位图框描述同一片内容时（如带线框的表）
    // 先合并，避免产出两片互相重叠的切片
    ...tableBoxes,
  ]);

  const figureRegions = expandRegionsToText(regionCandidates, flowItems, {
    pad: FIGURE_TEXT_PAD,
    bodyFontSize: style.bodyFontSize,
    maxFontRatio: FIGURE_TEXT_MAX_FONT_RATIO,
  });

  // ── 区域内正文块重标记 + 正文字号二次修正 ──
  //
  // 顺序很关键：必须在 figureRegions 算完之后、返回之前。
  // 图表标签字号 ≥ 正文的页面（附录大图、绕排图）上，字号判据反向失效，
  // 只有「块整体落在图形区域内」这个几何信号才可靠（见 remark 的注释）；
  // 而标签被移出正文流之后，正文字号的众数才有机会算对（见 refine 的注释）。
  remarkBodyBlocksInsideRegions(blocks, figureRegions, style.bodyBlockIds);
  refineBodyFontSize(blocks, style);

  // 内容边界：所有块的并集。它是重排后行宽（measure）的基准 ——
  // 双栏合一之后内容宽变成整幅版心，必须靠它把行宽约束回可读区间
  const contentBounds = unionBBox(blocks.map((b) => b.bbox));

  return {
    pageIndex,
    width,
    height,
    items,
    lines,
    blocks,
    columnBoundaries: layout.boundaries,
    columnSplits,
    bodyFontSize: style.bodyFontSize,
    bodyBlockCount: style.bodyBlockIds.size,
    contentBounds,
    figureRegions,
    tableRegions,
    referencesActive,
  };
}
