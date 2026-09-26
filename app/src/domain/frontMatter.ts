import type { Block } from '../types';

/**
 * 首页「前置内容」（标题 / 作者 / 机构 / 邮箱 / 日期）的识别与免译。
 *
 * ── 为什么需要它 ──
 * 用户的原话：「作者就不需要进行翻译了」。道理和参考文献一致：
 *   - **作者名不能译**：`Kaiming He` 译成中文就没法回查、也丧失指代意义
 *   - **机构 / 邮箱**同理——它们是标识符，不是自然语言
 *
 * ── 为什么用「纵向区间」而不是「逐块判定」──
 * 作者块在语料特征上与正文几乎一致（同字号、同宽度、同断点密度），
 * 没有任何一块能独立判出来。但它和标题、摘要一起占据了首页**顶部一段连续的区间**：
 * 标题（最大字号）在下，`Abstract`/`摘要` 标题在上界，两者之间的就是作者 / 机构 / 邮箱。
 * 这跟参考文献的「区间」思路是同一类问题（见 references.ts），只是区间在首页顶部。
 *
 * ── 实测依据（真实论文）──
 *   - ResNet（双栏）：标题 `Deep Residual Learning…`（字 1.44）→ 作者行 `Kaiming He…` /
 *     `Shaoqing Ren…`（字 1.20，跨两栏）→ 邮箱机构 → `Abstract` 标题（y=334）
 *   - 单栏样本：标题（字 1.55）→ `Jianshuo Dong1,…`（字 1.00）→ 机构行（字 0.90）→
 *     `ABSTRACT …` 块（y=318）。其中第二作者行字号仅 0.70，被字号判据误判成图内文字，
 *     但它落在 front-matter 区间里，照样被标成免译（渲染成图像本来就不译，更不会误译）。
 */
export const ABSTRACT_HEADING = /^(abstract|摘要|概要|ABSTRACT|ABSTRACT\.|SUMMARY|Summary|Summary\.)/i;

/** 标题判定的最小字号倍率（学术论文标题通常显著大于正文） */
const TITLE_MIN_SCALE = 1.3;
/** 仅在前 40% 页高内寻找标题，避免把正文里的大字标题（如章节标题）误当论文标题 */
const TITLE_REGION_RATIO = 0.4;
/** 摘要边界的兜底判据：首个「明显是正文段落」的块（宽比 ≥ 0.85 且足够长） */
const BODY_WIDTH_RATIO = 0.85;
const BODY_MIN_CHARS = 80;

/**
 * 在首页顶部寻找标题块：前 40% 页高内字号倍率最大、且 ≥ `TITLE_MIN_SCALE` 的块。
 * 找不到（没有足够大的字）返回 null —— 此时调用方应放弃 front-matter 标记，保守不误伤。
 */
export function findTitleBlock(blocks: Block[], pageHeight: number): Block | null {
  let title: Block | null = null;
  for (const b of blocks) {
    if (b.bbox.y > pageHeight * TITLE_REGION_RATIO) continue;
    if (b.fontScale >= TITLE_MIN_SCALE && (!title || b.fontScale > title.fontScale)) {
      title = b;
    }
  }
  return title;
}

/**
 * 首页 front-matter 的下界 y：标题与摘要之间的分界。
 *
 * 优先匹配 `Abstract`/`摘要` 等标题词（整块文本恰好以它开头）；
 * 找不到时用「首个看起来像正文段落的块」（宽比 ≥ 0.85 且较长）兜底——
 * 作者块普遍偏窄（宽比 0.5–0.8），而摘要 / 引言正文是整栏宽，区分很干净。
 *
 * 返回 Infinity 表示没找到下界（调用方应放弃）。
 */
export function findFrontMatterBoundary(blocks: Block[], titleY: number): number {
  let boundaryY = Infinity;
  for (const b of blocks) {
    if (b.bbox.y <= titleY) continue;
    const isAbstractHeading = ABSTRACT_HEADING.test(b.text.trim());
    const isWideBody = b.fontScale < 1.15 && b.widthRatio >= BODY_WIDTH_RATIO && b.text.length >= BODY_MIN_CHARS;
    if (isAbstractHeading || isWideBody) {
      boundaryY = Math.min(boundaryY, b.bbox.y);
    }
  }
  return boundaryY;
}

/**
 * 在首页标记 front-matter（标题 / 作者 / 机构 / 邮箱）的免译。
 * 会就地修改 `block.translatable` 与 `block.nonTranslatableReason`。
 *
 * ── 关键决策 ──
 *   - **只限第 1 页**：front-matter 只可能出现在首页。
 *   - **标题保持可译**：用户反对的是翻译「作者」，标题译成中文对中文读者有用，
 *     所以标题块（区间下界）特意排除在外。
 *   - **摘要标题保持可译**：`Abstract` → `摘要` 同样有用，且它正好位于边界 y 上
 *     （严格小于边界才标记），自然被排除。
 *   - 区间内所有块统一标 `authors`：作者、机构、邮箱、甚至日期/致谢都归到这一类，
 *     它们都不该被翻译；渲染层对 `authors` 与 `references` 同样按「保留文本不翻译」处理。
 *
 * @param blocks 本页的块（可来自任意页；非首页直接返回，不做任何修改）
 * @param pageHeight 本页高度（viewport 坐标，与 block.bbox 同一单位）
 */
export function markFrontMatter(blocks: Block[], pageHeight: number): void {
  if (blocks.length === 0 || blocks[0].pageIndex !== 0) return;

  const title = findTitleBlock(blocks, pageHeight);
  if (!title) return;

  const boundaryY = findFrontMatterBoundary(blocks, title.bbox.y);
  if (!Number.isFinite(boundaryY)) return;

  for (const block of blocks) {
    if (block === title) continue;
    // 严格落在 (title.y, boundaryY) 之间 —— 标题本身与摘要标题都不在内
    if (block.bbox.y > title.bbox.y && block.bbox.y < boundaryY) {
      block.translatable = false;
      block.nonTranslatableReason = 'authors';
    }
  }
}
