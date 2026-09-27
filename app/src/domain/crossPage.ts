import { maskInlineMath, type MathPiece } from './inlineMath';
import type { Block } from '../types';

/**
 * 跨页段落接续（I25）。
 *
 * ── 问题 ──
 * 段落重建是**逐页**进行的（analyzePage 的输入是单页的文本项），于是一段
 * 恰好跨过页边界的段落会被腰斩成两个块：
 *
 *   页 N 末尾：…the residual function is defined as   ← 前半段
 *   页 N+1 顶：y = F(x) + x, where x is the input…    ← 后半段
 *
 * 两半各自成为独立翻译单元，代价是双重的：
 *   - **译文质量**：前半段缺下文、后半段缺上文，模型各译各的，
 *     跨界处的指代与句法全部断裂；
 *   - **排版**：后半段在重排文档里被当成新段落，误加首行缩进，
 *     读起来像凭空多出一段。
 *
 * ── 方案 ──
 * 沿用参考文献区间的同一条「逐页串联」模式（referencesActive 的做法）：
 * 页 N 就绪时上报自己的「段落尾部」（最后一个可译正文块），页 N+1 拿着它
 * 与本页第一个可译正文块做接续判定；判定成立就把两半**合并成一个翻译单元**
 * （登记在后半段的 blockId 下），前半段不再单独送译。
 *
 * ── 为什么合并译文显示在后半段下面 ──
 * 瀑布流里页 N 与页 N+1 上下相接，读者实际看到的是：
 *   [前半段原文]（页底）→ [后半段原文]（次页顶，无缩进）→ [整段译文]
 * 这正是「一段原文一段译文」的对照结构，只是原文恰好跨过了页分隔线。
 * 把译文拆回两半（在接缝处切开中文）需要依赖模型输出分隔格式 ——
 * ADR-011 否决批量的同一条理由：切分错位比慢严重得多，所以不做拆分。
 *
 * ── 判据刻意保守 ──
 * 误合并会把两个无关段落搅在一起，比漏合并（现状，各译各的）更糟。
 * 因此：尾部必须以「句子未完」的字符收尾（字母/数字/逗号/分号/连接符），
 * 头部必须以小写字母/逗号/分号开头 —— 新段落以大写或编号开头，
 * 「where x is…」这类公式后的延续以小写开头，恰好被覆盖。
 * 冒号与右括号一律视为段落结束（后跟列表的情形远多于跨页延续）。
 * 中文段落头尾都无法区分延续与新段，v1 不做（行为与现状一致）。
 */

/** 页 N 的「段落尾部」：最后一个可译正文块及其占位保护后的形态 */
export interface ParagraphTailInfo {
  blockId: string;
  /** 块原文 */
  text: string;
  /** 行内公式占位后的送译文本（maskInlineMath 的产物） */
  masked: string;
  /** 占位对应的公式片段，合并译文回填时用 */
  pieces: MathPiece[];
}

/**
 * 尾部判定：文本以「句子未完」的字符收尾。
 *
 * 收尾字符是字母/数字 → 句子在词中间被截断；逗号/分号 → 子句未完；
 * 连接符（连字符 / en/em dash）→ 单词或行被断开。
 * 句号、问叹号、冒号、引号、括号、CJK 标点都算「段落可以在此结束」。
 */
export function endsOpen(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return false;
  return /[A-Za-z0-9,;\-–—]$/.test(t);
}

/**
 * 头部判定：以小写字母/逗号/分号开头 → 是上一段的自然延续。
 *
 * 刻意**不**接受数字与左括号开头：列表项（`(1) …`、`3. …`）与新段
 * 也以这些字符开头，而句子的延续以数字开头的情形极少（且漏合并无害）。
 */
export function startsContinuation(text: string): boolean {
  const t = text.trimStart();
  if (!t) return false;
  return /^[a-z,;]/.test(t);
}

/**
 * 从一页的块里取「段落尾部」候选：阅读顺序最后一个可译正文块。
 *
 * 过滤条件与翻译登记一致（isBodyText + translatable），额外要求
 * 非标题（标题常以无标点收尾，绝不能并进下一页）且非行间公式。
 * 页尾的页码、参考文献都不可译，天然被跳过。
 */
export function paragraphTailInfoOf(blocks: readonly Block[]): ParagraphTailInfo | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i];
    if (!b.isBodyText || !b.translatable || b.headingLevel !== 0 || b.formula) continue;
    const masked = maskInlineMath(b.text, b.spans);
    return { blockId: b.id, text: b.text, masked: masked.masked, pieces: masked.pieces };
  }
  return null;
}

/**
 * 接续判定：head 块是否为 tail 的同段延续。
 *
 * head 也要过与登记相同的过滤（可译正文、非标题、非公式）——
 * 把公式或标题并进译文单元，等于把「保持原样」的内容又送回了模型。
 */
export function isContinuation(
  tail: ParagraphTailInfo | null,
  head: Block | null
): boolean {
  if (!tail || !head) return false;
  if (!head.isBodyText || !head.translatable || head.headingLevel !== 0 || head.formula) {
    return false;
  }
  return endsOpen(tail.text) && startsContinuation(head.text);
}

/**
 * 合并两段的占位文本：尾部占位符**重编号**，避免与头部冲突。
 *
 * 占位标记 `[[MATH_n]]` 的 n 是**块内**序号（inlineMath.ts），
 * 两段各自从 0 编起 —— 直接拼接会出现两个 `[[MATH_0]]`，
 * 回填时会把同一个公式填进两个位置。重编号让合并后的标记全局唯一。
 *
 * 顺序无所谓（unmaskInlineMath 按标记逐个替换），但替换时必须用
 * split/join 全量替换：`[[MATH_1]]` 不会误伤 `[[MATH_11]]`
 * （后者在 `_1` 后面跟的是 `1` 不是 `]`），逐个编号偏移是安全的。
 */
export function mergeMasked(
  tailMasked: string,
  tailPieces: MathPiece[],
  headMasked: string,
  headPieces: MathPiece[]
): { masked: string; pieces: MathPiece[] } {
  const offset = headPieces.length;
  let shifted = tailMasked;
  const pieces: MathPiece[] = [];
  for (let i = 0; i < tailPieces.length; i += 1) {
    const marker = `[[MATH_${offset + i}]]`;
    shifted = shifted.split(`[[MATH_${i}]]`).join(marker);
    pieces.push({ marker, text: tailPieces[i].text });
  }
  for (const p of headPieces) pieces.push({ ...p });
  return { masked: `${shifted} ${headMasked}`, pieces };
}
