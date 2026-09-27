/**
 * 领域模型类型定义
 *
 * 与 ../docs/02-domain-model.md §3 对齐，但去掉了 DB 相关字段与 BlockType 类型系统
 * （前者是 I5，后者是 I4）。字段名保持一致，避免后续迭代重命名。
 *
 * 坐标约定：viewport 坐标系，原点在页面左上角，y 轴向下，单位为 CSS 像素。
 */

import type { TableRegion } from './domain/tables';

/** 轴对齐包围盒 */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** pdf.js 文本项的原始形态（只保留用到的字段） */
export interface RawTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

/** 归一化后的文本项 */
export interface TextItem {
  id: string;
  str: string;
  bbox: BBox;
  /** 基线 y（屏幕坐标，向下为正） */
  baselineY: number;
  fontSize: number;
  fontName: string;
  /** pdf.js 归一化后的字体族（sans-serif / serif / monospace） */
  fontFamily: string;
  /** 字重是否为粗体（由真实 PostScript 字体名判定，见 pdf/fontTraits.ts） */
  bold: boolean;
  /** 字形是否为斜体 */
  italic: boolean;
  /**
   * 是否被旋转（不是水平排布）。
   *
   * 为什么必须单独标出来：论文里有两类旋转文字——
   *   - 图的纵轴标签（如 `training error (%)`，旋转 90°）
   *   - arXiv 的竖排侧标（如 `arXiv:1512.03385v1 [cs.CV] 10 Dec 2015`）
   * 它们的 transform 里带旋转分量，`groupIntoLines` 用基线聚类会把它们**并进相邻的
   * 正文行**（实测第 1 页的侧标与正文粘成了
   * `arXiv:1512.03385v1 [cs.CV] 10 Dec 2015Deep convolutional neural networks`）。
   * 因此它们必须在成行之前就被剔除，而不是等到判定阶段再标记 ——
   * 那时候污染已经发生了。
   */
  rotated: boolean;
  /** 所属栏序号，由 assignColumns 填充；-1 表示未分配 */
  columnIndex: number;
}

/**
 * 文本片段：段落内一段样式一致的连续文字。
 *
 * 为什么必须保留它：论文里的**段首小标题**（`Identity vs. Projection Shortcuts.`）
 * 与**斜体术语**（`vs`、`bottleneck`）在纯文本化之后会全部退化成正文，
 * 排出来一眼就不像原论文。字段是相对**所属块文本**的字符偏移。
 */
export interface TextSpan {
  start: number;
  end: number;
  bold: boolean;
  italic: boolean;
  /**
   * 上下标标记。
   *
   * ── 为什么必须有 ──
   * PDF 里的下标（$W_i$ 的 i）是一个**独立的文本项**：字号更小、基线更低。
   * 纯拼接会把它拍平成全尺寸的 `Wi` —— 数学含义直接丢失，
   * 用户看到的是「公式全都变了形」。判定依据见 paragraphBuilder 的 makeLine：
   * 字号显著小于行内主字号、且基线偏离主基线。
   */
  script?: 'sub' | 'sup';
  /**
   * 是否属于**行内公式**（I19）。
   *
   * 判据在 paragraphBuilder：数学字体（CMMI/CMSY/CMEX/MTMI…）、
   * 上下标项、或数学符号占比高的文本项。
   * 送翻译前这类片段会被替换成占位标记、译完再原样回填 ——
   * 于是「公式不被翻译」在结构层成立，而不只靠提示词约束模型。
   */
  math?: boolean;
}

/** 一行：基线相近的文本项集合 */
export interface TextLine {
  id: string;
  itemIds: string[];
  text: string;
  /** 行内样式片段，偏移相对本行 text */
  spans: TextSpan[];
  bbox: BBox;
  baselineY: number;
  columnIndex: number;
  fontSize: number;
}

/**
 * 块：渲染单位。
 * I0 中所有块都是正文段落，不区分类型。
 */
/** 被判定为非正文（图形区域内）的原因 */
export type FigureReason = 'font-size' | 'graphics-region' | 'narrow' | 'table-region' | null;

/**
 * 「保留为文本但**不翻译**」的原因。
 *
 * ── 为什么必须和 isBodyText 分开 ──
 * 曾经只有一个 `isBodyText` 布尔，它同时决定两件事：**渲染成文本还是图像**、
 * **送不送翻译**。参考文献把这两个关注点撑开了：它的正文是文本（该可选可搜索），
 * 但译它没有意义 —— 作者名不能译，文献标题译了反而没法回查原文。
 *
 * 硬要用一个布尔表示，只能二选一：要么把参考文献降级成图像（不可选、不可搜），
 * 要么把 52 条文献全部送去翻译（白花钱、还制造错误译名）。
 *
 * `'numeric'` 覆盖两类「整块就是一个数」的内容，它们的共同点是**译了没有意义**：
 *   - **页码**：实测字号常大于正文（ResNet 第 9 页的 `9` 是 1.25 倍），
 *     于是被字号判据当成标题，还会被送去翻译 —— 页面上出现一个被译成中文的「9」
 *   - **表格单元格里的孤立数字**：实测第 5 页有 12 个（表格行里的层数、倍数等）
 *
 * 名字用 `numeric` 而不是 `page-number`，是因为后者会让排查时误以为
 * 「第 5 页怎么会有 12 个页码」，从而浪费时间去查一个不存在的问题。
 */
export type NonTranslatableReason = 'references' | 'numeric' | 'formula' | 'authors' | null;

/**
 * 块：渲染单位。
 * 一个块对应屏幕上某块区域，携带类型、可译标志与判定依据。
 */
export interface Block {
  id: string;
  pageIndex: number;
  columnIndex: number;
  /** 阅读顺序，文档内递增。编码为 columnIndex * 10000 + 段序号 */
  readOrder: number;
  bbox: BBox;
  lineIds: string[];
  text: string;
  /** 段落内样式片段，偏移相对本块 text（用于恢复粗体小标题与斜体术语） */
  spans: TextSpan[];

  // ── 以下字段由 analyzeTextStyle 填充，用于把正文重排成 HTML ──
  /** 块内文本的主字号 */
  fontSize: number;
  /** 相对本页正文字号的倍率 */
  fontScale: number;
  /** 是否加粗（由字体资源推断） */
  bold: boolean;
  /** 0 = 正文段落，1 = 三级标题，2 = 二级标题 */
  headingLevel: number;
  /**
   * 是否属于正文流。
   * false 表示它落在图形区域内（图表内部标签等），应整体保留为图像而非重排成文本。
   */
  isBodyText: boolean;
  /** 块宽 ÷ 所在栏实际内容宽度（判定依据之一，也用于调试展示） */
  widthRatio: number;
  /** 平均每行的大间隙次数（**仅诊断**，不参与判定） */
  gapsPerLine: number;
  /**
   * 是否送去翻译。
   *
   * 与 `isBodyText` 正交：`isBodyText` 决定渲染成文本还是图像，
   * `translatable` 决定送不送翻译。参考文献是「文本但不翻译」的典型 ——
   * 见 `NonTranslatableReason`。
   */
  translatable: boolean;
  /**
   * 是否为**行间公式**（独立成行的 display equation）。
   *
   * ── 为什么不能留在文本流里 ──
   * 文本化对公式是**有损**的：上下标拍平、斜体变量变正体、根号/求和符号变成
   * 单个 Unicode 字符甚至缺失。行内公式夹在正文里只能忍受（保住可读的上下文），
   * 行间公式是独立成行的，完全可以回退到图像切片（见 pageFlow），
   * 与 ADR-008/009 的「图形区域保留为图像」是同一条路线。
   *
   * 判定见 domain/formulas.ts。
   */
  formula: boolean;
  /** 不翻译的原因。null 表示可翻译 */
  nonTranslatableReason: NonTranslatableReason;
  /**
   * 被排除出正文流的原因。null 表示它是正文。
   *
   * 保留这个字段是为了**可解释性**：调参和排查误判时，必须能直接看到
   * 「这块是被哪条判据挡下来的」，否则只能靠反复打印猜测。
   * 后续「块类型手动改判」功能也依赖它展示当前判定依据。
   */
  figureReason: FigureReason;
}

/**
 * 翻译单元。
 * I0 中与 Block 一一对应；docs/02 设计的 N:1 聚合留到 I1。
 */
export interface Segment {
  id: string;
  pageIndex: number;
  columnIndex: number;
  readOrder: number;
  blockIds: string[];
  bbox: BBox;
  text: string;
  translation: string | null;
}

/** 一页解析完成后的全部产物 */
export interface PageAnalysis {
  pageIndex: number;
  width: number;
  height: number;
  items: TextItem[];
  lines: TextLine[];
  blocks: Block[];
  segments: Segment[];
  /** 栏边界，长度 = 栏数 + 1，从 0 到 width */
  columnBoundaries: number[];
  /** 检测到的栏缝中心 x */
  columnSplits: number[];
  /** 本页正文字号（按字符数加权的字号众数） */
  bodyFontSize: number;
  /** 被判定为正文流的块数量 */
  bodyBlockCount: number;
  /**
   * 本页处理完后，文档是否处于参考文献区间。
   *
   * 参考文献常常跨页（本页列末尾开始、下页继续），所以这个状态必须**逐页传递**。
   * 它随 PageAnalysis 一起返回，调用方把它喂给下一页的 analyzePage。
   */
  referencesActive: boolean;
  /**
   * 本页的图形区域（已扩展到包住图内的文字标签）。
   *
   * 由 `analyzePage` 统一算出，而不是让调用方各自聚类 ——
   * 这份几何同时被三处使用（图内文字判定、跨栏裁切、被切分自检），
   * 各算一遍迟早漂移。
   */
  figureRegions: BBox[];
  /**
   * 本页识别出的**文字表格**区域（domain/tables.ts）。
   *
   * 与 figureRegions 分开返回的原因：表格矩形没有矢量路径/位图做几何来源，
   * 但 pageFlow 的空隙切图只认 figurePaths —— 调用方必须把这份矩形
   * 并进 buildPageFlow 的 figurePaths，切片才会发生
   * （与 I13 位图框「只进 region 不进 figurePaths 就不切图」是同一类坑）。
   */
  tableRegions: TableRegion[];
  /**
   * 全页内容的包围盒。
   *
   * 用途：重排成单栏后，正文的排版宽度应该是「跨栏的整幅内容宽度」，
   * 而不是原来某一栏的宽度 —— 否则重排出来的文档只有半页宽。
   */
  contentBounds: BBox;
}
