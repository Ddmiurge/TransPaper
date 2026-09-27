import { useEffect, useRef } from 'react';

import type { BlockContextMenuInfo } from './PageFlowView';
import type { OverrideKind } from '../domain/overrides';

/**
 * 块类型手动改判菜单（I18，ADR-004 的用户兜底入口）。
 *
 * 定位是「纠正自动判据的错误」，不是排版工具 —— 所以只列类型、不给参数。
 * 各选项的文案都写成用户视角的效果（翻译 / 保留图像 / 保留切片），
 * 而不是内部术语（isBodyText / figureReason）。
 */

const OPTIONS: Array<{ kind: OverrideKind; label: string; hint: string }> = [
  { kind: 'body', label: '按正文重排', hint: '抽取为文本并翻译' },
  { kind: 'figure', label: '按图表保留', hint: '整块保留为原始图像' },
  { kind: 'formula', label: '按公式保留', hint: '保留为原始切片，不翻译' },
  { kind: 'table', label: '按表格保留', hint: '整表保留为原始图像' },
  { kind: 'reference', label: '按文献保留', hint: '保留文本但不翻译' },
  { kind: 'auto', label: '恢复自动判定', hint: '撤销手动改判' },
];

const KIND_LABEL: Record<string, string> = {
  body: '正文',
  figure: '图表',
  formula: '公式',
  table: '表格',
  reference: '文献',
};

interface Props {
  info: BlockContextMenuInfo;
  x: number;
  y: number;
  onPick: (kind: OverrideKind) => void;
  onClose: () => void;
}

export function OverrideMenu({ info, x, y, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  // 点外部 / Escape 关闭 —— 右键菜单的默认交互约定
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 贴近视口边缘时向内收 —— 菜单在右下角溢出比想象中常见
  const clampedX = Math.min(x, window.innerWidth - 240);
  const clampedY = Math.min(y, window.innerHeight - 260);

  return (
    <div ref={ref} className="override-menu" style={{ left: clampedX, top: clampedY }}>
      <div className="override-menu-preview" title={info.text}>
        {info.text.length > 60 ? `${info.text.slice(0, 60)}…` : info.text}
      </div>
      <div className="override-menu-state">
        {info.overridden ? (
          <>
            已改判为<strong>「{KIND_LABEL[info.overridden] ?? info.overridden}」</strong>
          </>
        ) : (
          '当前为自动判定'
        )}
      </div>
      {OPTIONS.map((o) => (
        <button
          key={o.kind}
          type="button"
          className={info.overridden === o.kind || (o.kind === 'auto' && !info.overridden) ? 'is-current' : ''}
          disabled={o.kind === 'auto' && !info.overridden}
          onClick={() => onPick(o.kind)}
        >
          <span className="override-menu-label">{o.label}</span>
          <span className="override-menu-hint">{o.hint}</span>
        </button>
      ))}
    </div>
  );
}
