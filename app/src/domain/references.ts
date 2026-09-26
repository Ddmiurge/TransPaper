import type { Block } from '../types';

/**
 * 参考文献区间的识别与标记。
 *
 * ── 为什么需要它 ──
 * 用户的原话：「引用就不需要翻译了」。这条要求背后的道理很硬：
 *   - **作者名不能译**：`Y. Bengio` 译成中文就没法回查了
 *   - **文献标题译了反而有害**：读者要靠原题去搜原文
 *   - **期刊名、卷号、页码一律是标识符**，不是自然语言
 * 所以对文献条目做翻译，最好的结果是浪费钱，最坏的结果是制造错误信息。
 *
 * ── 为什么用「区间」而不是「逐块判定」──
 * 单个文献条目在语料特征上和正文完全一致（同字号、同宽度、同断点密度），
 * 没有任何一块能独立判出来。但**整个区间**有一个明确的起点：`References` 标题。
 * 从标题往下直到下一个真标题之前，都是文献。这是个区间问题，不是分类问题。
 *
 * ── 状态必须跨页传递 ──
 * 文献表常从某页的栏末开始、下一页继续。所以判定要有入状态和出状态，
 * 由调用方逐页串联（见 `PageAnalysis.referencesActive`）。
 */

/**
 * 参考文献标题。
 *
 * 只匹配**整块文本恰好等于**标题词，不做前缀匹配 —— 正文里出现
 * "references are given in [12]" 这类句子时不能触发。
 * 中英文都覆盖（部分中文期刊混排英文标题）。
 */
const REFERENCE_HEADING = /^(references|bibliography|参考文献|引用文献|參考文獻)$/i;

/** 文献条目的开头形态：`[12]` / `[3]` / `12.` */
const REFERENCE_ENTRY_HEAD = /^\s*(\[\d{1,3}\]|\d{1,3}\.)/;

/**
 * 判断一个块是不是参考文献标题。
 *
 * 除了文本匹配，还要求它是**标题级的**（字号大于正文）。
 * 有些论文的正文里会独立成行地出现 "References" 作为普通词，
 * 那种情况字号与正文一致，不该被当成区间起点。
 */
export function isReferenceHeading(block: Block): boolean {
  if (!REFERENCE_HEADING.test(block.text.trim())) return false;
  return block.fontScale >= 1.05 || block.headingLevel > 0;
}

/**
 * 在阅读顺序内标记参考文献区间。
 *
 * 会就地修改 `block.translatable` 与 `block.nonTranslatableReason`。
 *
 * @param blocks 本页的块，**必须已按阅读顺序排好**
 * @param incomingActive 进入本页之前文档是否已在文献区间内
 * @returns 处理完本页之后的状态，供下一页使用
 */
export function markReferences(blocks: Block[], incomingActive: boolean): boolean {
  let active = incomingActive;

  for (const block of blocks) {
    if (!active) {
      if (isReferenceHeading(block)) {
        // 标题本身保持可译：它是章节名（`References` → `参考文献`），
        // 不是文献条目。用户反对的是翻译**条目**，不是这个词。
        active = true;
      }
      continue;
    }

    // ── 已在区间内：判断是否结束 ──
    //
    // 结束的信号是「出现一个不像文献条目的标题」——例如文献之后的
    // `Appendix A` 或 `A. Object Detection Baselines`。
    // 没有这条判断的话，文献之后的附录会被整段吞掉、完全不翻译。
    const isHeading = block.headingLevel > 0;
    const looksLikeEntry = REFERENCE_ENTRY_HEAD.test(block.text);
    if (isHeading && !looksLikeEntry) {
      active = false;
      continue;
    }

    block.translatable = false;
    block.nonTranslatableReason = 'references';
  }

  return active;
}
