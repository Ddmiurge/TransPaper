import type { Segment } from '../types';

interface Props {
  segments: Segment[];
  /** 译文与原文段落下缘的间距（px） */
  gap: number;
  visible: boolean;
  collapsed: boolean;
}

/**
 * 覆盖式对照层（T0.7）
 *
 * 译文的注入位置 = 所属 Segment 的 bbox 下缘 + gap。
 * 这是 docs/adr/ADR-003 的核心做法：不改动 PDF 本身，只在其上方叠一层文本。
 *
 * I0 只实现「撑开」的一种形态 —— 而且是简化版：译文直接绝对定位，允许压住下方内容。
 * 折叠 / 浮层两种模式属 I1/I2。
 */
export function ParallelLayer({ segments, gap, visible, collapsed }: Props) {
  if (!visible) return null;

  return (
    <div className="layer parallel-layer">
      {segments.map((segment) => {
        if (!segment.translation) return null;
        return (
          <div
            key={segment.id}
            data-segment={segment.id}
            className={`translation${collapsed ? ' collapsed' : ''}`}
            title={`${segment.id} | 原文 ${segment.text.length} 字 → 译文 ${segment.translation.length} 字`}
            style={{
              left: segment.bbox.x,
              top: segment.bbox.y + segment.bbox.height + gap,
              width: Math.max(40, segment.bbox.width),
            }}
          >
            {segment.translation}
          </div>
        );
      })}
    </div>
  );
}
