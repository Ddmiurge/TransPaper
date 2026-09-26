import type { Block } from '../types';

/**
 * 行间公式识别（display equation）
 *
 * ── 为什么是「区间外的独立判定」而不是文本分类 ──
 * 公式条目的**字符形态**与正文差异极大（几乎没有英文长词、运算符密集），
 * 这一点足以把它从正文里认出来 —— 不需要像参考文献那样靠区间。
 *
 * ── 判据的优先级 ──
 * 1. **编号信号**（最硬）：LaTeX 的 `equation` 环境几乎必然在行尾右侧挂
 *    `(N)` 编号。一条「以 (N) 结尾」的正文段极其罕见 —— 要再配上
 *    「数学符号密度」与「几乎没有长英文单词」两个确认信号才认定。
 * 2. **无编号公式**：`equation*` / 多行 `align` 环境不带编号。判据收紧到
 *    「符号密度极高 + 零长单词 + 单行」，正文里不存在这种形态。
 *
 * ── 为什么要防误报 ──
 * 「as shown in Table 3 (1).」这样的句子也以 (1) 结尾。
 * 三重判据里真正把这类句子挡住的是长单词计数 ——
 * 正常句子的 ≥3 字母单词远多于公式（公式里只有 sin/cos/exp 这类函数名）。
 */

/** 行尾的公式编号：`(1)` / `(12)` / `(3a)` 后允许句点收尾 */
export const EQ_NUMBER = /\((\d{1,3}[a-z]?)\)\s*\.?\s*$/;

/**
 * 数学函数名白名单：公式里「合法」的英文长词。
 * 不在名单里的 ≥3 字母单词才计入「长单词」。
 */
const MATH_WORDS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'lg',
  'exp', 'min', 'max', 'arg', 'sup', 'inf', 'det', 'dim', 'lim', 'mod',
  'gcd', 'lcm', 'var', 'std', 'relu', 'sig', 'sgn', 'softmax',
]);

/** 判断一个字符是否属于「数学符号」——出现在运算、集合、希腊字母等区间 */
function isMathChar(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x2200 && c <= 0x22ff) || // ∀∃∈∑∏√≈≠≤≥∞ ← 运算符与数学符号
    (c >= 0x2a00 && c <= 0x2aff) || // ⨁⨀ 大运算符补充区
    (c >= 0x0370 && c <= 0x03ff) || // αβγ…ω 希腊字母
    (c >= 0x1d400 && c <= 0x1d7ff) || // 𝑥𝑦 数学斜体/双体字母
    (c >= 0x2100 && c <= 0x214f) || // ℓℜℑ 字母符号
    (c >= 0x2070 && c <= 0x209f) || // ⁰¹²₍₎ 上下标字符
    (c >= 0x2190 && c <= 0x21ff) || // →←⇒ 箭头
    ch === '±' ||
    ch === '×' ||
    ch === '÷' ||
    ch === '∂' ||
    ch === '∇' ||
    ch === '−' // U+2212 数学减号（常见于 PDF 提取）
  );
}

/** ASCII 里同样有「数学含义」的结构符号 —— 密度统计的另一半 */
function isMathAscii(ch: string): boolean {
  return (
    ch === '=' || ch === '+' || ch === '<' || ch === '>' || ch === '{' || ch === '}' ||
    // 圆括号必须计入：实测 2608.02657 第 4 页的 `L = − y_i log p_i + (1 − y_i) log(1 − p_i) , (1)`
    // 没有大括号，圆括号是唯一的结构符号 —— 不计入则密度只有 0.13，判据失效。
    // 正常句子不受影响：括号在句子里占比极低，防误报靠的是长单词计数。
    ch === '(' || ch === ')'
  );
}

interface LineSignals {
  /** 数学符号（Unicode + ASCII 结构符，含括号）占非空白字符的比例 */
  mathDensity: number;
  /** 强运算符密度：数学符号里去掉单纯的圆括号。
   *  用于无编号判定 —— 避免 `Eq. (1)` 这种只有括号、没有真正运算符的文本被误判。 */
  strongDensity: number;
  /** ≥3 字母、且不在数学函数白名单里的单词数 */
  longWords: number;
  numbered: boolean;
}

function lineSignals(text: string): LineSignals {
  let mathCount = 0;
  let strongCount = 0;
  let totalCount = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    totalCount += 1;
    if (isMathChar(ch) || isMathAscii(ch)) {
      mathCount += 1;
      if (ch !== '(' && ch !== ')') strongCount += 1;
    }
  }

  const words = text.match(/[A-Za-z]{3,}/g) ?? [];
  const longWords = words.filter((w) => !MATH_WORDS.has(w.toLowerCase())).length;

  return {
    mathDensity: totalCount > 0 ? mathCount / totalCount : 0,
    strongDensity: totalCount > 0 ? strongCount / totalCount : 0,
    longWords,
    numbered: false,
  };
}

/**
 * 判定一个块是否为行间公式。
 *
 * 行内信号必须**每一行**都满足：多行公式（align 环境）拆出的块里，
 * 任何一行混进了正文句子，整个块都应该留给正文流。
 */
function looksLikeFormula(block: Block): boolean {
  // 只判「正文流内的可译块」：图内标签、文献、页码已有各自的归宿
  if (!block.isBodyText || !block.translatable) return false;
  // 标题不可能是公式（字号判据已把标题分开，这里双保险）
  if (block.headingLevel > 0) return false;
  // 行数太多的块几乎不可能是公式 —— align 环境的行通常被间隙切开了（放宽到 8 行，
  // 让被拆成多行的整段公式仍有机会被认出；真正的防线是下面的零长单词判据）
  if (block.lineIds.length > 8) return false;

  // 块文本不含换行（拼接时用空格连接行），「单行」由 lineIds.length 表达
  const signals = lineSignals(block.text);
  const numbered = EQ_NUMBER.test(block.text);

  if (numbered) {
    // 编号 + 确认信号。判据从「长单词 ≤2」改为「强运算符密度 ≥0.1」，原因是：
    // 用描述性多字母标识符的公式（如 `min Lret + λ1 · Lsemantic + λ2 · Lperceptual (2)`、
    // `∆reason(madv) = EQ[…] (4)`）会有很多 ≥3 字母的标识符，把长单词数推过 2，
    // 同时把数学密度稀释到 0.18 以下 —— 旧判据会把这类真正的公式放行去翻译。
    // 真正区分「公式」与「以 (N) 结尾的正文句子」的是强运算符：公式里 = + − ∈ λ 密布，
    // 而 `as shown in Table 3 (1).` / `Eq. (1)` 这类句子**一个强运算符都没有**。
    return signals.strongDensity >= 0.1;
  }

  // 无编号：长英文词为 0 是强防线（正文句子必有 ≥3 字母词，极简等式 a = b 也没有）。
  // 必须同时有「强运算符」（= + − × ÷ ≈ ≤ ≥ < > 等，不含单纯括号），
  // 否则 `Eq. (1)` 这种只有括号的文本会被误判成公式。
  //   - 单行：强密度 ≥0.3 —— `a = b` / `x = y + z` 这类极简等式密度约 0.33，
  //     旧阈值（对 mathDensity ≥0.4）会漏掉它们，让它们被送去翻译。
  //   - 多行（2–8 行）：强密度 ≥0.25 —— align 环境被拆成多行、且首行未被认出时，
  //     拼接后密度被稀释，阈值相应放宽；零长单词仍把正文段落挡在门外。
  if (signals.longWords !== 0) return false;
  const single = block.lineIds.length === 1;
  const multi = block.lineIds.length >= 2;
  return (
    (single && signals.strongDensity >= 0.3) ||
    (multi && signals.strongDensity >= 0.25)
  );
}

/**
 * 标记行间公式块：`formula = true`、不翻译。
 *
 * 渲染层（pageFlow）据此把它作为图像切片输出 —— 公式的像素由原始 PDF 保证，
 * 上下标、斜体、根号、分式原样保留。
 */
export function markFormulas(blocks: Block[]): number {
  let count = 0;
  for (const block of blocks) {
    if (looksLikeFormula(block)) {
      block.formula = true;
      block.translatable = false;
      block.nonTranslatableReason = 'formula';
      count += 1;
    }
  }
  count += absorbFormulaFragments(blocks);
  return count;
}

/**
 * 第二遍：把与公式块**纵向重叠**的短小正文块并入公式。
 *
 * ── 为什么必须有 ──
 * display 公式环境（尤其是 aligned）在提取后会被拆成多个块：
 * 实测 2608.02657 第 4 页的公式 (1) 拆成了 `X = {x⁽¹⁾,…}`（残块 `XN`）、
 * 主式 `L = … , (1)`、求和上下限（字号判据已挡下）三部分，且它们的
 * y 区间**互相重叠**（上下标伸进了邻行的 y 范围）。只有主式能被
 * 第一遍认出来 —— 残块 `XN` 只有三个字符，什么信号都没有，
 * 会被当成正文送去翻译，渲染成一行莫名其妙的「XN」。
 *
 * 判据刻意保守：必须是正文流内的可译块、纵向真正重叠（不是相邻）、
 * 行数 ≤3 且文本 ≤40 字符。正常正文段落彼此不会纵向重叠，
 * 所以这个条件几乎不可能误伤。
 */
function absorbFormulaFragments(blocks: Block[]): number {
  const formulas = blocks.filter((b) => b.formula);
  if (formulas.length === 0) return 0;

  const overlaps = (a: Block, b: Block): number => {
    const y0 = Math.max(a.bbox.y, b.bbox.y);
    const y1 = Math.min(a.bbox.y + a.bbox.height, b.bbox.y + b.bbox.height);
    return y1 - y0;
  };

  let count = 0;
  for (const block of blocks) {
    if (block.formula || !block.isBodyText || !block.translatable) continue;
    if (block.headingLevel > 0) continue;
    if (block.lineIds.length > 3 || block.text.length > 40) continue;
    if (formulas.some((f) => f.columnIndex === block.columnIndex && overlaps(f, block) >= 2)) {
      block.formula = true;
      block.translatable = false;
      block.nonTranslatableReason = 'formula';
      count += 1;
    }
  }
  return count;
}
