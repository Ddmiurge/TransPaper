import { useCallback, useLayoutEffect, type MouseEvent, type ReactNode, type RefObject } from 'react';

import type { PageFlow } from '../domain/pageFlow';
import type { TextSpan } from '../types';

/**
 * 按样式片段渲染原文。
 *
 * 这不是装饰性需求：论文里的段首小标题（`Identity vs. Projection Shortcuts.`）
 * 和斜体术语（`vs`、`bottleneck`）如果退化成普通正文，整段读起来就没有结构，
 * 一眼能看出"这不是原论文排出来的"。
 */
function renderSpans(text: string, spans: TextSpan[]): ReactNode {
  if (spans.length === 0) return text;

  /** 按粗斜体包一层。上下标再在外面包 <sub>/<sup> —— 嵌套方向不能反：
   * `<sub><strong>` 与 `<strong><sub>` 视觉一致，但后者多一层嵌套。 */
  const styleChunk = (chunk: string, span: TextSpan, key: string): ReactNode => {
    if (span.bold && span.italic) {
      return (
        <strong key={key}>
          <em>{chunk}</em>
        </strong>
      );
    }
    if (span.bold) return <strong key={key}>{chunk}</strong>;
    if (span.italic) return <em key={key}>{chunk}</em>;
    return chunk;
  };

  const parts: ReactNode[] = [];
  let cursor = 0;

  spans.forEach((span, i) => {
    if (span.start > cursor) parts.push(text.slice(cursor, span.start));
    const chunk = text.slice(span.start, span.end);
    // 上下标：PDF 里它们是独立的小字号文本项，拼接后被拍平成全尺寸 ——
    // $W_i$ 会变成 `Wi`，数学含义直接丢失。这里用原生标签还原层级。
    if (span.script === 'sub') {
      parts.push(
        <sub key={`s${i}`}>{styleChunk(chunk, span, `b${i}`)}</sub>
      );
    } else if (span.script === 'sup') {
      parts.push(
        <sup key={`s${i}`}>{styleChunk(chunk, span, `b${i}`)}</sup>
      );
    } else {
      parts.push(styleChunk(chunk, span, `s${i}`));
    }
    cursor = span.end;
  });

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export interface FlowMeasurement {
  nodeCount: number;
  sliceCount: number;
  textCount: number;
  translatedCount: number;
  /** 重排后内容总高度 */
  totalHeight: number;
  /** 撑开倍数：重排后高度 ÷ 原始页面高度 */
  stretchRatio: number;
  /** 空切片数量（说明切分算错了） */
  emptySlices: number;
  /** 文本节点的数量（可选中、可搜索） */
  selectableParagraphs: number;
}

/**
 * 阅读行宽（measure），单位为 em。
 *
 * ── 为什么必须有这个约束 ──
 * 双栏论文的两栏合一之后，行宽会变成原来的两倍。实测 150% 下页面内容宽 743px、
 * 正文字号 16.8px，即一行 44em（约 88 个西文字符）—— 这远超舒适阅读区间，
 * 读起来是"文字墙"，也正是"重排后不像正常段落"的主要来源。
 *
 * 36em 对应约 72 个西文字符或 36 个汉字，落在书籍排版的常规区间内。
 * 字号放大后 measure 会同步放大，因此三档缩放下的观感保持一致。
 */
const MEASURE_EM = 36;

interface Props {
  flow: PageFlow;
  /** 整页离屏 canvas，图像切片的像素从这里裁 */
  sourceCanvas: HTMLCanvasElement | null;
  /** 正文基准字号（px），其他字号按 fontScale 缩放 */
  baseFontSize: number;
  rootRef: RefObject<HTMLDivElement | null>;
  onMeasured?: (m: FlowMeasurement) => void;
  /**
   * 段落右键（I18 手动改判）。在文档流容器上做事件委托——
   * 每个文本节点几百个，逐个挂监听不如在根上接一次。
   */
  onBlockContextMenu?: (info: BlockContextMenuInfo, x: number, y: number) => void;
}

/** 右键命中的段落信息（给改判菜单用） */
export interface BlockContextMenuInfo {
  blockId: string;
  /** 改判锚点（页码 + 归一化文本前缀，见 domain/overrides.ts） */
  anchor: string;
  /** 段落文本（菜单里展示，帮助用户确认改的是哪段） */
  text: string;
  /** 当前是否已被手动改判及其类型；null = 自动判定 */
  overridden: string | null;
}

/**
 * 文档流视图 —— 单栏中英对照
 *
 * 正文段落渲染成真正的 HTML 文本（可选中、可搜索），图表等图形区域用 drawImage
 * 从离屏 canvas 裁出来，像素完全来自原始 PDF。
 *
 * 译文不是"浮在原文上的层"，而是文档流里的普通段落 —— 因此"每段原文下方紧跟译文"
 * 是字面意义上的实现，不存在覆盖或重叠的可能。
 */
export function PageFlowView({ flow, sourceCanvas, baseFontSize, rootRef, onMeasured, onBlockContextMenu }: Props) {
  const contentWidth = Math.max(1, flow.stats.contentWidth);
  const measure = Math.min(contentWidth, MEASURE_EM * baseFontSize);

  /** 右键委托：从事件目标向上找文本节点，命中才交给菜单 */
  const handleContextMenu = useCallback(
    (e: MouseEvent) => {
      if (!onBlockContextMenu) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-block-id]');
      if (!el) return;
      e.preventDefault();
      const node = flow.nodes.find((n) => n.kind === 'text' && n.blockId === el.dataset.blockId);
      if (!node || node.kind !== 'text') return;
      onBlockContextMenu(
        {
          blockId: node.blockId,
          anchor: node.anchor ?? '',
          text: node.source,
          overridden: node.overridden ?? null,
        },
        e.clientX,
        e.clientY
      );
    },
    [flow.nodes, onBlockContextMenu]
  );

  /**
   * 图形切片的显示缩放 —— **按图自身的宽度**算，而不是整幅版心的统一比例。
   *
   * 曾经用 `measure / contentWidth` 这个统一比例，理由是「保持原版式的横向关系」。
   * 但那对重排文档没有意义：重排本来就是要丢弃版式。代价却很实：
   * 实测第 4 页的架构图裁切范围是 x 111→427（占栏宽 76%），
   * 在 675px 的版心里只显示 287px、还贴在左侧，右边留一大片空白 ——
   * 看起来就像「图被切掉了一半」。
   *
   * 现在按图自身宽度缩放：不超过版心宽度（需要缩小），也不过度放大
   * （上限 1.5 倍，再大就开始糊了 —— 离屏画布本身就是 1.5 倍渲染的）。
   * 配合 CSS 的 `margin: 0 auto` 居中，就是论文插图的常规做法。
   */
  const MAX_SLICE_BOOST = 1.5;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const dpr = window.devicePixelRatio || 1;
    let emptySlices = 0;

    if (sourceCanvas) {
      for (const node of flow.nodes) {
        if (node.kind !== 'slice') continue;
        const el = root.querySelector<HTMLCanvasElement>(`canvas[data-slice="${node.id}"]`);
        if (!el) continue;

        const src = node.source;
        if (src.width < 1 || src.height < 1) emptySlices += 1;

        // 公式切片不放大到行宽 —— `y = F(x)+x` 拉到整行宽会大得离谱。
        // 按「正文字号基准」缩放：baseFontSize（重排文档的正文字号，随缩放档位变）
        // ÷ bodyFontSize（页面上正文的原始字号），公式字面高度即与两侧正文一致。
        const scale = node.scaleToText
          ? baseFontSize / Math.max(1, flow.bodyFontSize)
          : Math.min(measure / Math.max(1, src.width), MAX_SLICE_BOOST);
        const cssW = Math.max(1, Math.round(src.width * scale));
        const cssH = Math.max(1, Math.round(src.height * scale));
        const pw = Math.max(1, Math.round(cssW * dpr));
        const ph = Math.max(1, Math.round(cssH * dpr));

        if (el.width !== pw) el.width = pw;
        if (el.height !== ph) el.height = ph;
        el.style.width = `${cssW}px`;
        el.style.height = `${cssH}px`;

        const ctx = el.getContext('2d');
        if (!ctx) continue;
        ctx.clearRect(0, 0, pw, ph);
        // 源区域按原始倍率取，目标区域按 measure 缩放 —— 缩放后依然清晰
        ctx.drawImage(
          sourceCanvas,
          Math.round(src.x * dpr),
          Math.round(src.y * dpr),
          Math.round(src.width * dpr),
          Math.round(src.height * dpr),
          0,
          0,
          pw,
          ph
        );
      }
    }

    onMeasured?.({
      nodeCount: flow.nodes.length,
      sliceCount: flow.stats.sliceCount,
      textCount: flow.stats.textCount,
      translatedCount: flow.stats.translatedCount,
      totalHeight: root.scrollHeight,
      stretchRatio: Number((root.scrollHeight / flow.pageHeight).toFixed(2)),
      emptySlices,
      selectableParagraphs: root.querySelectorAll('.flow-source').length,
    });
  }, [flow, sourceCanvas, baseFontSize, rootRef, onMeasured, measure]);

  return (
    <div
      ref={rootRef}
      className="page-flow"
      style={{ width: Math.round(measure), fontSize: baseFontSize }}
      onContextMenu={handleContextMenu}
    >
      {flow.nodes.map((node) => {
        if (node.kind === 'slice') {
          return <canvas key={node.id} data-slice={node.id} className="flow-slice" />;
        }

        const size = baseFontSize * node.fontScale;
        const isHeading = node.headingLevel > 0;
        const HeadingTag = node.headingLevel === 2 ? 'h2' : node.headingLevel === 1 ? 'h3' : 'p';
        // 译文字号要跟随原文。否则图注（0.9 倍）的译文会比原文还大，一眼就不对。
        // 标题例外：译文按正文字号排，不跟着标题放大。
        const targetSize = isHeading ? baseFontSize : size;

        return (
          <article
            key={node.id}
            data-block-id={node.blockId}
            className={`flow-block${isHeading ? ' flow-block--heading' : ''}`}
          >
            <HeadingTag
              className={
                `flow-source` +
                (node.bold ? ' is-bold' : '') +
                (isHeading ? ' is-heading' : '') +
                // 参考文献与页码：保留为可选中的文本，但不翻译。
                // 换用文献的排版（悬挂缩进、字号略小）—— 让它看起来仍像一份文献表，
                // 而不是被重排成 52 个普通段落
                (node.translatable ? '' : ' is-untranslated') +
                (node.nonTranslatableReason === 'references' ? ' is-reference' : '')
              }
              style={{ fontSize: size }}
            >
              {renderSpans(node.source, node.spans)}
            </HeadingTag>
            {/* 不翻译的内容没有译文块 —— 这是「引用不需要翻译」在渲染上的落地 */}
            {node.translatable && node.target && (
              <p className="flow-target" style={{ fontSize: targetSize }}>
                {node.target}
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}
