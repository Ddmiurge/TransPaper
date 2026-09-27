import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PageFlowView, type FlowMeasurement, type BlockContextMenuInfo } from './PageFlowView';
import { buildPageFlow } from '../domain/pageFlow';
import { figurePathBoxes, isEnclosedByGraphics } from '../domain/figureRegions';
import { analyzePage } from '../domain/pipeline';
import { applyOverrides, AutoJudgmentStash } from '../domain/overrides';
import { overrideStore } from '../state/overrideStore';
import { mockTranslate } from '../mock/translations';
import { canvasHasInk } from '../pdf/canvasUtils';
import { extractPageItems, renderPageToOffscreen } from '../pdf/pdfjsAdapter';
import { extractImageBoxes, extractPathBoxes } from '../pdf/vectorGraphics';
import { translationStore, useTranslationsFor } from '../state/translationStore';
import { useTranslationSettings } from '../state/translationSettings';
import type { BBox, PageAnalysis } from '../types';

/** 稳定的空 Map —— 每次渲染都新建会让下游的 useMemo 白算 */
const EMPTY_TRANSLATIONS: ReadonlyMap<string, string> = new Map();

/**
 * 图形路径坐标的可信度下限。
 *
 * 路径是绘图指令，画出来的框里必然有墨 —— 比例低就说明坐标算错了。
 * 坐标不可信时宁可不做「图形区域补刀」，也不要拿错几何去判定文字。
 */
const GEOMETRY_CONFIDENCE_FLOOR = 0.5;

/** 探测路径框里有没有墨迹时，给框留的外扩量（px） */
const PATH_PROBE_PAD = 3;

/** 判定「文字被图形夹住」时允许的最大距离（PDF 点） */
const FIGURE_MAX_DISTANCE = 3;

export interface PageReadyInfo {
  analysis: PageAnalysis;
  geometryConfidence: number;
  /**
   * 本页处理完后，文档是否处于参考文献区间。
   *
   * 上游把它记下来，喂给下一页 —— 文献表常跨页，这个状态必须串联。
   */
  referencesActive: boolean;
}

interface PageData extends PageReadyInfo {
  offscreen: HTMLCanvasElement;
  figurePaths: BBox[];
  figureRegions: BBox[];
}

interface Props {
  /** pdf.js 的文档对象。就绪前为 null，此时不做任何事 */
  doc: any;
  pageNumber: number;
  scale: number;
  /** 是否允许开始加载。瀑布流用它实现「顺序加载」——上一页好了才轮到下一页 */
  enabled: boolean;
  /** 正文基准字号（px，CSS 像素），由外层按缩放算好 */
  baseFontSize: number;
  /**
   * 进入本页之前，文档是否已处于参考文献区间。
   *
   * 瀑布流是顺序加载的，所以外层拿到上一页的结果时，下一页尚未开始 —— 天然成立。
   */
  referencesActive: boolean;
  /**
   * 文档级重排行宽基准（全文档已见页面的最大内容宽）。
   * 收尾页只有半栏内容时仍按常规行宽排（见 PageFlowOptions.readingWidth）。
   */
  docReadingWidth: number;
  onReady: (pageNumber: number, info: PageReadyInfo) => void;
  /** 渲染完成后的测量结果（面板用）。瀑布流下由外层只保留最新一份 */
  onMeasured?: (m: FlowMeasurement) => void;
  /** 段落右键（I18 手动改判），由 App 统一渲染菜单 */
  onBlockContextMenu?: (info: BlockContextMenuInfo, x: number, y: number) => void;
}

/**
 * 单页的文档流区块 —— 瀑布流的一个单元。
 *
 * 为什么把这一整段逻辑（渲染离屏画布 → 提取 → 分析 → 切图）收进组件、而不是放在 App 里：
 * 每一页都需要**自己的一份**离屏画布、图形路径、跨栏区域与译文映射。
 * 放在 App 里就得为每一页维护一组 state（`analysis1`、`analysis2`… 或一个 map + 一堆空值判断），
 * 收进组件后这些状态天然按页隔离，互不干扰。
 *
 * 顺序加载由外层的 `enabled` 控制：第 N 页就绪 → 外层放开第 N+1 页。
 * 不做并发是因为 pdf.js 对同一文档的并发页面请求本就会排队，
 * 而且同时渲染十几页会瞬间吃掉几百 MB 内存。
 */
export function PageFlowBlock({
  doc,
  pageNumber,
  scale,
  enabled,
  baseFontSize,
  referencesActive,
  docReadingWidth,
  onReady,
  onMeasured,
  onBlockContextMenu,
}: Props) {
  const [data, setData] = useState<PageData | null>(null);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 防止 scale 变化时重复触发：一页只加载一次 */
  const startedRef = useRef(false);
  /**
   * 自动判定暂存（I18）：改判与撤销都从这里出发才能幂等 ——
   * 块字段被改判覆写后，没有「自动值」就回不去了。
   * 生命周期跟页面的 analysis 一致（每页一份）。
   */
  const stashRef = useRef(new AutoJudgmentStash());

  useEffect(() => {
    if (!doc || !enabled || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;

        const offscreen = await renderPageToOffscreen(page, scale);
        if (cancelled) return;

        const extracted = await extractPageItems(page, pageNumber - 1, scale);
        if (cancelled) return;

        const rawPaths = await extractPathBoxes(page, scale);
        // 位图（嵌入图片）的放置框 —— ACL 等排版的图表是整张 PNG/JPEG，
        // 矢量路径为 0，不看位图等于对这类论文关闭图表检测
        const rawImages = await extractImageBoxes(page, scale);
        if (cancelled) return;

        // 坐标可信度自检：把路径框外扩几像素再探墨。
        // 路径框常常只有 1px 宽（细线），而采样是每 4 像素取一点 ——
        // 不外扩的话竖线会被整条跳过，坐标本来正确的页面也会被判成不可信。
        const inked = rawPaths.filter((box) =>
          canvasHasInk(
            offscreen,
            {
              x: box.x - PATH_PROBE_PAD,
              y: box.y - PATH_PROBE_PAD,
              width: box.width + PATH_PROBE_PAD * 2,
              height: box.height + PATH_PROBE_PAD * 2,
            },
            236
          )
        ).length;
        const geometryConfidence = rawPaths.length === 0 ? 1 : inked / rawPaths.length;
        const trusted = geometryConfidence >= GEOMETRY_CONFIDENCE_FLOOR;

        // figurePaths 是「切片几何」的统一来源：空隙切图、区域扩展、绕排判定都看它。
        // 位图框必须并入 —— 否则位图图表虽然被识别为图形区域，
        // 空隙切图却因「该带没有矢量路径」而不发生，整张图照样丢失
        // （实测 ACL 样本第 17 页：Figure 6 检测到了却没被切出来）。
        // 位图框本身就是实打实的墨迹，无需墨迹自检。
        const figurePaths = trusted
          ? figurePathBoxes(rawPaths).concat(rawImages)
          : rawImages.length > 0
            ? rawImages
            : [];

        const analysis = analyzePage({
          pageIndex: pageNumber - 1,
          width: extracted.width,
          height: extracted.height,
          items: extracted.items,
          options: {
            // 图形区域在域层统一算（路径聚类 + 扩展到包住图内文字），
            // 这里把原始路径交给它，避免同一份几何在两处各算一遍
            rawPaths,
            rawImages,
            // 文献区间要跨页传递
            referencesActive,
            // 像素层的补刀：字号判不出来的模糊区间，用「四周是否被图形线条夹住」定夺
            isInsideFigure: (bbox) =>
              isEnclosedByGraphics(bbox, figurePaths, FIGURE_MAX_DISTANCE * scale),
          },
        });
        if (cancelled) return;

        // 文字表格矩形必须并入切片几何 —— 与 I13 位图框同一个坑：
        // 只进 region 不进 figurePaths，空隙切图会因「该带没有图形」而不发生，
        // 整张表格照样丢失（表格没有矢量路径，几何来源只能是识别出的矩形本身）。
        const sliceGeometry = figurePaths.concat(analysis.tableRegions.map((t) => t.bbox));

        // 手动改判（I18）：在 buildPageFlow 之前套用 —— 块的最终判定
        // 是「自动判定 + 用户改判」两层叠加（ADR-004 的双层设计）
        applyOverrides(analysis.blocks, overrideStore.getSnapshot().byAnchor, stashRef.current);

        setData({
          analysis,
          geometryConfidence,
          referencesActive: analysis.referencesActive,
          offscreen,
          figurePaths: sliceGeometry,
          // 用域层算好的图形区域（已扩展到包住图内文字）。跨栏判定交给域层。
          figureRegions: analysis.figureRegions,
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, enabled, pageNumber, scale, referencesActive]);

  // 就绪后通知外层：放开下一页
  useEffect(() => {
    if (data) {
      onReady(pageNumber, {
        analysis: data.analysis,
        geometryConfidence: data.geometryConfidence,
        referencesActive: data.analysis.referencesActive,
      });
    }
  }, [data, pageNumber, onReady]);

  // 改判变化（I18）：从暂存的自动值出发重新套用，再整体重建文档流。
  // 恢复是幂等的 —— 覆写多少次都能回到自动判定
  useEffect(() => {
    return overrideStore.subscribe(() => {
      if (!data) return;
      applyOverrides(data.analysis.blocks, overrideStore.getSnapshot().byAnchor, stashRef.current);
      setData({ ...data });
    });
  }, [data]);

  /**
   * 可译段落的 blockId。
   *
   * 只把 `isBodyText` 的块登记进翻译流水线 —— 这正是架构里
   * 「非文本块根本不进翻译流水线」（ADR-004）的落地方式：
   * 图内标签、表格数据行在 `analyzePage` 里就被排除了，
   * 到这里已经不需要再判断一次。
   */
  const translatable = useMemo(
    () =>
      data
        ? data.analysis.blocks.filter((b) => b.isBodyText && b.translatable).map((b) => b.id)
        : [],
    [data]
  );

  // 登记待翻译段落。**幂等**，所以缩放切换导致的重渲染是安全的
  useEffect(() => {
    if (!data) return;
    translationStore.register(
      data.analysis.blocks
        .filter((b) => b.isBodyText && b.translatable)
        .map((b) => ({ id: b.id, text: b.text }))
    );
  }, [data]);

  const realTranslations = useTranslationsFor(translatable);
  const { previewMode } = useTranslationSettings();

  const translations = useMemo(() => {
    if (!data) return EMPTY_TRANSLATIONS;
    // 未开启预览模式时直接用真实译文（没有就是空，页面只显示原文）
    if (!previewMode) return realTranslations;
    // 预览模式：真实译文优先，缺的用占位译文补上 ——
    // 这样在没配 API Key 时也能评估排版，且一旦接入真实模型会自动覆盖
    const map = new Map<string, string>();
    for (const block of data.analysis.blocks) {
      if (!block.isBodyText) continue;
      map.set(block.id, realTranslations.get(block.id) ?? mockTranslate(block.text));
    }
    return map;
  }, [data, realTranslations, previewMode]);

  const hasContent = useCallback(
    (bbox: BBox) => (data ? canvasHasInk(data.offscreen, bbox) : true),
    [data]
  );

  const flow = useMemo(() => {
    if (!data) return null;
    return buildPageFlow(data.analysis, translations, {
      hasContent,
      figurePaths: data.figurePaths,
      figureRegions: data.figureRegions,
      // 文档级行宽基准：收尾页只有半栏内容时仍按常规行宽排
      readingWidth: docReadingWidth > 0 ? docReadingWidth : undefined,
      // 手动改判：文本节点据此打 overridden 标记（块本身的改判已在 analyze 后套用）
      overrides: overrideStore.getSnapshot().byAnchor,
    });
  }, [data, translations, hasContent, docReadingWidth]);

  if (error) {
    return (
      <section className="flow-page" data-page={pageNumber}>
        <p className="flow-page-placeholder bad">第 {pageNumber} 页解析失败：{error}</p>
      </section>
    );
  }

  if (!flow) {
    return (
      <section className="flow-page is-loading" data-page={pageNumber}>
        <p className="flow-page-placeholder">第 {pageNumber} 页 · 正在解析…</p>
      </section>
    );
  }

  const scanned = data?.analysis.items.length === 0;

  return (
    <section className="flow-page" data-page={pageNumber}>
      <div className="flow-page-label">第 {pageNumber} 页</div>
      <PageFlowView
        flow={flow}
        sourceCanvas={data?.offscreen ?? null}
        baseFontSize={baseFontSize}
        rootRef={rootRef}
        onMeasured={onMeasured}
        onBlockContextMenu={onBlockContextMenu}
      />
      {scanned && (
        <p className="flow-page-placeholder bad">
          本页没有文本层 —— 可能是扫描版 PDF。当前版本不支持 OCR，只能以原版式查看。
        </p>
      )}
    </section>
  );
}
