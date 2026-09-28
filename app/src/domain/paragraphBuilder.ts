import { median } from './stats';
import { unionBBox } from './bbox';
import { isMathChar } from './formulas';
import type { Block, TextItem, TextLine, TextSpan } from '../types';

/**
 * 段落重建（ParagraphBuilder v0）
 *
 * 与 ../docs/02-domain-model.md §5 的算法对齐，但 I0 只实现一部分：
 *   ✅ 行聚合、按间隙切段、字号变化切段、连字符还原
 *   ❌ 跨页续接（I25 已在 crossPage.ts 以合并翻译单元的方式实现）、可疑段落标注
 *   （docs/02 设计的「多 Block 聚合为 Segment」从未落地，Segment 层已随
 *    CODE_AUDIT D1 移除——翻译单元就是 Block）
 *
 * 参数值为 I0 的初始猜测，I1 阶段用黄金数据集标定。函数签名与参数名不要改。
 */
export interface ParagraphBuildOptions {
  /** 同行判定：baseline 差值 ≤ 中位字号 × 此比例 */
  lineToleranceRatio: number;
  /** 段边界判定：行间空隙 > 中位空隙 × 此倍数 */
  paragraphGapMultiplier: number;
  /** 段边界判定下限：行间空隙 > 中位行高 × 此比例（防止中位空隙为 0 时全部粘连） */
  minParagraphGapRatio: number;
  /**
   * 首行缩进判据：行左边缘比栏内主流左边缘右移超过「字号 × 此比例」，即视为新段首行。
   *
   * ── 为什么必须有这条 ──
   * 学术论文的段落主要靠**首行缩进**标记，段间纵向空隙往往和行距一样大。
   * 只靠行距切段在真实论文上会失败：实测有正文被并成一个 y 从 270 跨到 1069 的
   * 巨型块（40 多行、好几个自然段粘在一起），同时段尾的孤立短行又被拆成小块。
   * 单个巨型块作为翻译单元，译文质量和「段落级对照」都无从谈起。
   */
  firstLineIndentRatio: number;
  /**
   * 悬挂缩进判据：组内多数行缩进、少数行顶格时，把顶格行视为新条目的首行。
   *
   * ── 为什么必须有这一条 ──
   * **参考文献用悬挂缩进排版**（首行顶格、续行缩进），恰好与正文的首行缩进**相反**。
   * 于是 `firstLineIndentRatio` 那条判据在这里彻底失效：
   * `dominantLeftEdge` 会把「缩进的续行」认成主流左边缘（因为续行数量更多），
   * 阈值随之右移到没有任何行能超过的位置，整栏文献被并成**一个块**。
   * 实测 ResNet 第 9 页：`[1] Y. Bengio…` 那一段有 **63 行**、y 从 136 跨到 1068，
   * 用户看到的就是「引用全都挤成了一堆」。
   *
   * 取 0.5em 作缩进判定：悬挂缩进的续行通常缩进 1em 以上，而标点悬挂远小于此。
   */
  hangingIndentRatio: number;
  /** 悬挂缩进时判定「顶格」的容差（相对字号） */
  hangingFlushToleranceRatio: number;
  /** 字号相对变化超过此比例视为新段落（标题、图表题注） */
  fontSizeBreakRatio: number;
  /** 文本拼接时判定需要插入空格的最小水平间隔（相对字号） */
  spaceGapRatio: number;
}

export const DEFAULT_PARAGRAPH_OPTIONS: ParagraphBuildOptions = {
  lineToleranceRatio: 0.5,
  paragraphGapMultiplier: 1.6,
  minParagraphGapRatio: 0.25,
  firstLineIndentRatio: 0.8,
  hangingIndentRatio: 0.5,
  hangingFlushToleranceRatio: 0.25,
  fontSizeBreakRatio: 0.2,
  spaceGapRatio: 0.15,
};

/** 判断字符是否为 CJK（决定拼接时是否补空格） */
function isCJK(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/**
 * 把同一栏内的文本项聚合成行。
 * 输入应已按栏筛选，不同栏的文本项不要混在一起传入。
 */
export function groupIntoLines(
  items: TextItem[],
  opts: Partial<ParagraphBuildOptions> = {}
): TextLine[] {
  const o = { ...DEFAULT_PARAGRAPH_OPTIONS, ...opts };
  if (items.length === 0) return [];

  const medianFontSize = median(items.map((i) => i.fontSize)) || 1;
  const tolerance = medianFontSize * o.lineToleranceRatio;

  const sorted = [...items].sort(
    (a, b) => a.baselineY - b.baselineY || a.bbox.x - b.bbox.x
  );

  const groups: TextItem[][] = [];
  let current: TextItem[] = [sorted[0]];
  let referenceBaseline = sorted[0].baselineY;

  for (let i = 1; i < sorted.length; i += 1) {
    const item = sorted[i];
    if (Math.abs(item.baselineY - referenceBaseline) <= tolerance) {
      current.push(item);
    } else {
      groups.push(current);
      current = [item];
      referenceBaseline = item.baselineY;
    }
  }
  groups.push(current);

  return groups.map((group, index) => makeLine(group, index, o));
}

/**
 * 追加一个样式片段；与上一个片段样式相同且首尾相接时合并，
 * 避免产生大量只有一个空格或一个字母的碎片。
 */
function appendSpan(
  spans: TextSpan[],
  start: number,
  end: number,
  bold: boolean,
  italic: boolean,
  script?: TextSpan['script'],
  math?: boolean
): void {
  if (end <= start) return;
  const last = spans[spans.length - 1];
  // 相邻同款式合并。允许跨越**一个空格**：拼接时会在两段之间补空格，
  // 若因此把一个纯正文段落切成几十个碎片，片段数就完全失去意义了。
  // script 必须相同才能合并 —— 上下标与其相邻正文被空格隔开时，
  // 合并会把下标拍平回全尺寸（正是这个字段要修的问题）。
  // math 同理：合并跨越正文会把正文也圈进公式片段，译时就被占位符吃掉。
  if (
    last &&
    last.bold === bold &&
    last.italic === italic &&
    last.script === script &&
    !!last.math === !!math &&
    start - last.end <= 1
  ) {
    last.end = end;
    return;
  }
  spans.push(script || math ? { start, end, bold, italic, script, math } : { start, end, bold, italic });
}

/** 把片段的偏移整体平移并裁剪到 [0, length) 之内 */
function shiftSpans(spans: TextSpan[], delta: number, length: number): TextSpan[] {
  const out: TextSpan[] = [];
  for (const span of spans) {
    const start = Math.max(0, span.start + delta);
    const end = Math.min(length, span.end + delta);
    if (end > start) appendSpan(out, start, end, span.bold, span.italic, span.script, span.math);
  }
  return out;
}

function makeLine(group: TextItem[], index: number, o: ParagraphBuildOptions): TextLine {
  const ordered = [...group].sort((a, b) => a.bbox.x - b.bbox.x);
  const fontSize = median(ordered.map((i) => i.fontSize)) || 1;
  const spaceThreshold = fontSize * o.spaceGapRatio;

  // ── 上下标判定的基准 ──
  // 主基线 = **主字号项**的基线。不能用首项（ordered[0]，按 x 排序）：
  // 行首若恰好是上标引用标记（如 `text²` 的 ²），首项基线就是错的。
  // 主字号取最大值而不是中位数：下标项通常只占少数，中位数会被正文拉住，
  // 但极少数「整行都是下标」的行会反过来 —— 那是奇怪的排版，宁可漏判。
  const mainFontSize = Math.max(...ordered.map((i) => i.fontSize));
  const mainBaseline = ordered.find((i) => i.fontSize >= mainFontSize * 0.95)?.baselineY
    ?? ordered[0].baselineY;
  // 容差必须**极小**。实测 ResNet 第 3 页：公式 (1) 里下标 i 的基线只比主基线
  // 低 1.49px ≈ 0.15em —— 曾用 0.22em 容差，恰好把它放过了（脚注上标的偏移
  // 更大所以能抓到，下标全漏）。而同一行的正常文本项基线**完全相同**
  // （分毫不差，PDF 的文本矩阵就是同一个值），所以 0.06em 的容差
  // 既不会误伤同行项，又能抓住最浅的下标。
  const baselineTolerance = Math.max(mainFontSize * 0.06, 0.3);

  /**
   * 判定一个文本项是不是上下标。
   *
   * 两个条件缺一不可：
   *   - **字号**显著小于主字号（上下标通常是主字号的 0.6–0.75 倍）
   *   - **基线**偏离主基线（下标更低、上标更高；本坐标系 y 向下增长）
   *
   * 只有字号小、基线却在主基线上的项不判 —— 那更像小型大写或特殊符号。
   */
  const scriptOf = (item: TextItem): TextSpan['script'] => {
    if (item.fontSize >= mainFontSize * 0.85) return undefined;
    if (Math.abs(item.baselineY - mainBaseline) <= baselineTolerance) return undefined;
    // y 向下：下标的基线比主基线**大**（更低），上标更小（更高）
    return item.baselineY > mainBaseline ? 'sub' : 'sup';
  };

  /**
   * 行内公式判定（I19）：数学字体 / 上下标项 / 数学符号占比高，任一命中即算。
   *
   * 只标「片段」不改动文本 —— 翻译层据此把公式段替换成占位标记，
   * 译完再原样回填（见 domain/inlineMath.ts）。
   */
  const isMathItem = (item: TextItem): boolean => {
    if (scriptOf(item)) return true;
    if (isMathFont(item.fontName)) return true;
    return mathCharRatio(item.str) >= 0.4;
  };

  let raw = '';
  const rawSpans: TextSpan[] = [];
  let prevRight = Number.NEGATIVE_INFINITY;

  for (const item of ordered) {
    const gap = item.bbox.x - prevRight;
    // 行尾连字符处不补空格：`Learn-` + `ing` 必须拼成 `Learning`，
    // 中间插一个空格会让连字符还原彻底失效（实测过）。
    const hyphenJoin = raw.endsWith('-') && /^[a-z]/.test(item.str);
    const needsSpace =
      raw.length > 0 &&
      !hyphenJoin &&
      gap > spaceThreshold &&
      !raw.endsWith(' ') &&
      !item.str.startsWith(' ') &&
      !isCJK(raw[raw.length - 1]) &&
      !isCJK(item.str[0]);
    if (needsSpace) {
      // 空格不计入任何片段 —— 片段应当恰好对应被样式化的文字。
      // 渲染时片段之间的空隙会作为普通文本输出（见 renderSpans）。
      raw += ' ';
    }
    const start = raw.length;
    raw += item.str;
    appendSpan(rawSpans, start, raw.length, item.bold, item.italic, scriptOf(item), isMathItem(item));
    prevRight = item.bbox.x + item.bbox.width;
  }

  // trim 会改变偏移，必须把片段一起平移
  const text = raw.trim();
  const leading = raw.length - raw.trimStart().length;
  const first = ordered[0];

  return {
    // 行 id 必须含栏号：groupIntoLines 是「按栏」调用的，index 在每栏内都从 0 开始，
    // 只用 `line-${index}` 会让左右栏的同名行互相覆盖。
    // （曾因此让左栏所有段落误用右栏的行做样式分析，把图内标签判成了正文。）
    id: `line-c${first.columnIndex}-${index}`,
    itemIds: ordered.map((i) => i.id),
    text,
    spans: shiftSpans(rawSpans, -leading, text.length),
    bbox: unionBBox(ordered.map((i) => i.bbox)),
    baselineY: first.baselineY,
    columnIndex: first.columnIndex,
    fontSize,
  };
}

/**
 * 数学字体判定。
 *
 * LaTeX 排版的公式用独立字体：CMMI（数学斜体）、CMSY（符号）、CMEX（大运算符），
 * 以及 MathTime 的 MTMI/MTSY/MSAM。这些字体在正文里几乎不出现 ——
 * 「字体是数学字体」比「这段文字长得像公式」可靠得多。
 *
 * 子集化字体名带 `ABCDEF+` 前缀，必须先剥掉。
 */
const MATH_FONT = /^(CMMI|CMMIB|CMSY|CMEX|CMEXB|MTMI|MTSY|MSAM|MSBM|MTEX)/i;

function isMathFont(fontName: string): boolean {
  if (!fontName) return false;
  return MATH_FONT.test(fontName.replace(/^[A-Z]{6}\+/, ''));
}

/** 非空白字符里数学符号的占比（判据复用 formulas.ts，避免第二份实现） */
function mathCharRatio(text: string): number {
  let math = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    total += 1;
    if (isMathChar(ch)) math += 1;
  }
  return total === 0 ? 0 : math / total;
}

/**
 * 找出这一栏（或这一组行）的「主流左边缘」。
 *
 * 用众数而不是最小值：个别行可能因为首字符形状或标点悬挂而略微左凸，
 * 最小值会被它带偏，众数则稳稳落在绝大多数行的共同左边缘上。
 * 左边缘量化到 2px 一档，避免浮点抖动把同一列拆成好几个桶。
 */
function dominantLeftEdge(lines: TextLine[]): number {
  const buckets = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.bbox.x / 2) * 2;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  let bestKey = lines[0].bbox.x;
  let bestCount = -1;
  for (const [key, count] of buckets) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  return bestKey;
}

/**
 * 参考文献条目的开头：`[12]` / `[12, 21]` / `[3]`。
 *
 * 这是比悬挂缩进**更硬**的信号：条目编号必须递增，误判几乎不可能。
 * 悬挂缩进是通用规则（覆盖其他悬挂缩进的内容），编号序列是针对性规则（覆盖文献表）。
 * 两者都实现，编号优先 —— 前者可能在条目全是单行时失效，后者不会。
 */
const REFERENCE_ENTRY = /^\s*\[(\d{1,3})\]/;

/** 组内是否存在递增的 `[N]` 编号序列（至少 3 条才认，避免正文里的偶然引用触发） */
function referenceEntryStarts(group: TextLine[]): number[] {
  const hits: number[] = [];
  let last = -1;
  for (let i = 0; i < group.length; i += 1) {
    const m = REFERENCE_ENTRY.exec(group[i].text);
    if (!m) continue;
    const n = Number(m[1]);
    // 编号必须严格递增：这是「条目边界」而不是「句子里的引用」
    if (n > last) {
      hits.push(i);
      last = n;
    }
  }
  return hits.length >= 3 ? hits : [];
}

/** 按给定的起始下标切分一个组 */
function splitAtIndexes(group: TextLine[], starts: number[]): TextLine[][] {
  const set = new Set(starts.filter((i) => i > 0));
  const out: TextLine[][] = [];
  let current: TextLine[] = [group[0]];
  for (let i = 1; i < group.length; i += 1) {
    if (set.has(i)) {
      out.push(current);
      current = [group[i]];
    } else {
      current.push(group[i]);
    }
  }
  out.push(current);
  return out;
}

/**
 * 组内切分：根据**这个组自己的缩进结构**决定用哪条判据切段。
 *
 * ── 为什么必须收敛到组内 ──
 * 最初的实现把「首行缩进」判据放在了**整栏**层面：先算全栏的主流左边缘，
 * 再把明显右移的行当作段首行。这在一栏里同时包含正文与文献时就会出错 ——
 * 整栏的主导结构是哪一种，另一类内容就得按错的规则切。
 *
 * 实测的后果：合成用例里「顶格行与缩进行数量相当」时，第一级就把文献切成
 * 每行一块（6 块而不是 3 块），第二级无论怎么判都救不回来 —— 组已经碎了。
 *
 * 收敛到组内之后，判定范围与「一个语义单元」重合，两类结构各自按对的规则走。
 *
 * 判据优先级：
 *   1. **递增的 `[N]` 序列** —— 最硬，编号必须递增，误判几乎不可能
 *   2. **悬挂缩进** —— 缩进行占多数、顶格行占少数（与正文恰好相反）
 *   3. **首行缩进** —— 默认规则，正文的形态
 */
function splitGroupIntoEntries(group: TextLine[], o: ParagraphBuildOptions): TextLine[][] {
  if (group.length < 2) return [group];

  const fontSize = median(group.map((l) => l.fontSize)) || 1;
  const xs = group.map((l) => l.bbox.x);
  const minX = Math.min(...xs);
  const flushTolerance = fontSize * o.hangingFlushToleranceRatio;

  // ── 1. 带编号的文献表 ──
  const numbered = referenceEntryStarts(group);
  if (numbered.length >= 3) return splitAtIndexes(group, numbered);

  // 行数太少时识别不出结构，切了也没有收益
  if (group.length < 4) return [group];

  // ── 2. 悬挂缩进 ──
  const indentUnit = fontSize * o.hangingIndentRatio;
  const flushCount = xs.filter((x) => x <= minX + flushTolerance).length;
  const indentedCount = xs.filter((x) => x > minX + indentUnit).length;
  const isHanging = flushCount >= 2 && flushCount < group.length / 2 && indentedCount >= 2;
  if (isHanging) {
    return splitAtLines(group, (line) => line.bbox.x <= minX + flushTolerance);
  }

  // ── 3. 首行缩进（默认）──
  const leftEdge = dominantLeftEdge(group);
  const threshold = leftEdge + fontSize * o.firstLineIndentRatio;
  return splitAtLines(group, (line) => line.bbox.x > threshold);
}

/** 在一个组内，把满足 `isBoundary` 的行作为新段的起始行切开 */
function splitAtLines(group: TextLine[], isBoundary: (line: TextLine) => boolean): TextLine[][] {
  const out: TextLine[][] = [];
  let current: TextLine[] = [group[0]];
  for (let i = 1; i < group.length; i += 1) {
    if (isBoundary(group[i])) {
      out.push(current);
      current = [group[i]];
    } else {
      current.push(group[i]);
    }
  }
  out.push(current);
  return out;
}

/**
 * 把行聚合成段落。
 * 输入应已按阅读顺序（栏内自上而下）排好序。
 */
export function buildParagraphs(
  lines: TextLine[],
  pageIndex: number,
  opts: Partial<ParagraphBuildOptions> = {}
): Block[] {
  const o = { ...DEFAULT_PARAGRAPH_OPTIONS, ...opts };
  if (lines.length === 0) return [];

  const medianLineHeight = median(lines.map((l) => l.bbox.height)) || 1;
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    gaps.push(lines[i].bbox.y - (lines[i - 1].bbox.y + lines[i - 1].bbox.height));
  }
  const positiveGaps = gaps.filter((g) => g > 0);
  const medianGap = positiveGaps.length > 0 ? median(positiveGaps) : 0;
  const gapThreshold = Math.max(
    medianGap * o.paragraphGapMultiplier,
    medianLineHeight * o.minParagraphGapRatio
  );

  // ── 第一级：只按纵向间隙与字号变化分组 ──
  //
  // 刻意**不在这里**用缩进判据：缩进规则必须看「一个组自己的结构」才知道该用哪一种
  // （见 splitGroupIntoEntries 的注释）。放在这一级会按整栏的主导结构一刀切，
  // 遇到一栏里混着正文与文献时必然出错。
  const groups: TextLine[][] = [];
  let current: TextLine[] = [lines[0]];

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const prev = lines[i - 1];
    const gap = line.bbox.y - (prev.bbox.y + prev.bbox.height);
    const fontSizeChanged =
      prev.fontSize > 0 && Math.abs(line.fontSize - prev.fontSize) / prev.fontSize > o.fontSizeBreakRatio;

    if (gap > gapThreshold || fontSizeChanged) {
      groups.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  groups.push(current);

  // ── 第二级：组内按缩进结构切分 ──
  const entries = groups.flatMap((group) => splitGroupIntoEntries(group, o));

  return entries.map((group, index) => makeBlock(group, index, pageIndex));
}

function makeBlock(group: TextLine[], index: number, pageIndex: number): Block {
  let raw = '';
  const rawSpans: TextSpan[] = [];

  for (const line of group) {
    if (raw.length === 0) {
      // 第一行
    } else if (raw.endsWith('-') && /^[a-z]/.test(line.text)) {
      // 行尾连字符还原：把上一行末尾的 "-" 去掉，两行直接相接
      raw = raw.slice(0, -1);
      for (const span of rawSpans) {
        if (span.end > raw.length) span.end = raw.length;
      }
    } else {
      const needsSpace = !isCJK(raw[raw.length - 1]) && !isCJK(line.text[0]);
      // 同 makeLine：空格不归入片段
      if (needsSpace) raw += ' ';
    }

    const base = raw.length;
    raw += line.text;
    for (const span of line.spans) {
      // math 必须随块级片段一起传递 —— 漏了它，行级标出的行内公式
      // 会在块级合并时被吞掉（I19 定位到的正是这个丢失点）
      appendSpan(rawSpans, base + span.start, base + span.end, span.bold, span.italic, span.script, span.math);
    }
  }

  const text = raw.trim();
  const leading = raw.length - raw.trimStart().length;
  const columnIndex = group[0].columnIndex;

  return {
    id: `p${pageIndex}-c${columnIndex}-b${index}`,
    pageIndex,
    columnIndex,
    readOrder: columnIndex * 10000 + index,
    bbox: unionBBox(group.map((l) => l.bbox)),
    lineIds: group.map((l) => l.id),
    text,
    spans: shiftSpans(rawSpans, -leading, text.length),
    // 以下字段先给保守默认值，随后由 analyzeTextStyle 统一计算覆盖
    fontSize: median(group.map((l) => l.fontSize)),
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
  };
}
