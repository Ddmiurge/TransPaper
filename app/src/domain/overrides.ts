import type { Block } from '../types';

/**
 * 块类型手动改判（I18）—— ADR-004 承诺的用户兜底入口。
 *
 * ── 为什么必须有 ──
 * 自动判据（字号 / 矢量路径 / 表格网格 / 公式形态）在真实论文上必然有误判率：
 * 把正文判成图内文字 → 凭空消失；把图表判成正文 → 被翻译得乱七八糟。
 * ADR-004 的原始设计就是「自动判定 + 用户改判」两层：判据可以保守，
 * 因为错了用户能改。没有这个入口，任何自动判据的误判都是死局。
 *
 * ── 锚点为什么用「页码 + 文本前缀」而不是块 id ──
 * 块 id（`p{页}-c{栏}-b{序}`）是**序号**：上游判定一变（例如一次改判让某块
 * 从正文流里消失），后续块的序号会整体位移，重新解析后 id 对不上。
 * 内容锚点（页码 + 归一化文本前缀）不依赖序号，同一篇 PDF 重析后必然命中。
 */

/** 改判后的块类型。`auto` 表示撤销改判、回到自动判定 */
export type OverrideKind = 'body' | 'figure' | 'formula' | 'table' | 'reference' | 'auto';

/** 一条改判记录（按锚点持久化） */
export interface BlockOverride {
  anchor: string;
  kind: Exclude<OverrideKind, 'auto'>;
}

/**
 * 计算块的改判锚点：页码 + 归一化文本前缀。
 *
 * 归一化把所有空白折叠成单空格 —— PDF 提取的空格数量随提取参数波动，
 * 前缀 40 字符在「唯一性」与「抗布局漂移」之间取平衡。
 */
export function anchorOf(block: Block): string {
  const normalized = block.text.replace(/\s+/g, ' ').trim().slice(0, 40);
  return `${block.pageIndex}|${normalized}`;
}

/** 块上与改判相关的自动判定快照（恢复用） */
export interface AutoJudgment {
  isBodyText: boolean;
  translatable: boolean;
  formula: boolean;
  figureReason: Block['figureReason'];
  nonTranslatableReason: Block['nonTranslatableReason'];
}

/** 暂存每块的自动判定结果，改判/撤销都要从这里出发（幂等的关键） */
export class AutoJudgmentStash {
  private byId = new Map<string, AutoJudgment>();

  /** 首次见到某块时记录其自动判定；已记录的不覆盖 */
  capture(block: Block): void {
    if (this.byId.has(block.id)) return;
    this.byId.set(block.id, {
      isBodyText: block.isBodyText,
      translatable: block.translatable,
      formula: block.formula,
      figureReason: block.figureReason,
      nonTranslatableReason: block.nonTranslatableReason,
    });
  }

  restore(block: Block): void {
    const auto = this.byId.get(block.id);
    if (!auto) return;
    block.isBodyText = auto.isBodyText;
    block.translatable = auto.translatable;
    block.formula = auto.formula;
    block.figureReason = auto.figureReason;
    block.nonTranslatableReason = auto.nonTranslatableReason;
  }
}

/**
 * 把一条改判应用到块上（调用方需先用 stash.restore 归零）。
 *
 * 各类型的落点与自动判定保持同一语义：
 *   - figure / table → 移出正文流（isBodyText=false），整体走图像切片
 *   - formula → 保留正文流身份、以 scaleToText 切片输出（见 formulas.ts）
 *   - reference → 保留为文本但免译（悬挂缩进渲染，见 references.ts）
 *   - body → 正文流 + 送翻译
 */
export function applyOverride(block: Block, kind: OverrideKind): void {
  if (kind === 'auto') return;
  switch (kind) {
    case 'body':
      block.isBodyText = true;
      block.formula = false;
      block.figureReason = null;
      block.translatable = true;
      block.nonTranslatableReason = null;
      break;
    case 'figure':
      block.isBodyText = false;
      block.figureReason = 'graphics-region';
      block.translatable = false;
      break;
    case 'table':
      block.isBodyText = false;
      block.figureReason = 'table-region';
      block.translatable = false;
      break;
    case 'formula':
      block.formula = true;
      block.translatable = false;
      block.nonTranslatableReason = 'formula';
      break;
    case 'reference':
      block.translatable = false;
      block.nonTranslatableReason = 'references';
      break;
  }
}

/**
 * 对一页的块施加全部改判。
 *
 * 流程：先暂存自动判定 → 逐块恢复 → 按锚点套用改判。
 * 重复调用是幂等的（restore 总是从暂存的自动值出发）。
 * 返回实际生效的改判数（供调试面板展示）。
 */
export function applyOverrides(
  blocks: Block[],
  overrides: ReadonlyMap<string, OverrideKind>,
  stash: AutoJudgmentStash
): number {
  // 注意：即使 overrides 为空也要逐块恢复 —— 「撤销最后一条改判」后
  // byAnchor 变空，此时块还带着上一次改判的覆写，必须从暂存恢复
  let applied = 0;
  for (const block of blocks) {
    stash.capture(block);
    stash.restore(block);
    const kind = overrides.get(anchorOf(block));
    if (!kind) continue;
    applyOverride(block, kind);
    if (kind !== 'auto') applied += 1;
  }
  return applied;
}
