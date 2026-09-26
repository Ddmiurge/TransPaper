import type { PageAnalysis } from '../types';

interface Props {
  analysis: PageAnalysis;
  showItems: boolean;
  showBlocks: boolean;
  showColumns: boolean;
}

const COLUMN_COLORS = ['#2dd4bf', '#a78bfa', '#fbbf24', '#f87171'];

/**
 * 坐标校验层（T0.4）
 *
 * 这是 I0 最关键的一层：在继续做任何功能之前，必须先用眼睛确认
 * 「每个框都恰好框住对应的文字」。坐标若错了，后面所有验证都是无效的。
 */
export function DebugLayer({ analysis, showItems, showBlocks, showColumns }: Props) {
  return (
    <div className="layer debug-layer">
      {showColumns &&
        analysis.columnSplits.map((x, i) => (
          <div key={`gutter-${i}`} className="gutter-line" style={{ left: x }} />
        ))}

      {showItems &&
        analysis.items.map((item) => (
          <div
            key={item.id}
            className="item-box"
            title={`${item.id} | x=${item.bbox.x.toFixed(1)} y=${item.bbox.y.toFixed(1)} ` +
              `w=${item.bbox.width.toFixed(1)} h=${item.bbox.height.toFixed(1)} | ${item.str}`}
            style={{
              left: item.bbox.x,
              top: item.bbox.y,
              width: item.bbox.width,
              height: item.bbox.height,
            }}
          />
        ))}

      {showBlocks &&
        analysis.blocks.map((block) => (
          <div
            key={block.id}
            className="block-box"
            style={{
              left: block.bbox.x,
              top: block.bbox.y,
              width: block.bbox.width,
              height: block.bbox.height,
              borderColor: COLUMN_COLORS[block.columnIndex % COLUMN_COLORS.length],
            }}
          >
            <span
              className="block-label"
              style={{ background: COLUMN_COLORS[block.columnIndex % COLUMN_COLORS.length] }}
            >
              {block.columnIndex}:{block.readOrder % 10000}
            </span>
          </div>
        ))}
    </div>
  );
}
