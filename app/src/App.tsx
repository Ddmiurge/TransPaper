import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import fixtureUrl from '../fixtures/two-column-sample.pdf?url';
import { DebugLayer } from './components/DebugLayer';
import { LibrarySidebar } from './components/LibrarySidebar';
import { libraryStore } from './library/libraryStore';
import type { PaperMeta } from './library/types';
import { PageFlowBlock, type PageReadyInfo } from './components/PageFlowBlock';
import type { FlowMeasurement } from './components/PageFlowView';
import { ParallelLayer } from './components/ParallelLayer';
import { buildPageFlow, type PageFlow } from './domain/pageFlow';
import { figurePathBoxes, isEnclosedByGraphics } from './domain/figureRegions';
import { analyzePage } from './domain/pipeline';
import { findTitleBlock } from './domain/frontMatter';
import { selfCheck, type SelfCheckReport } from './domain/selfCheck';
import { mockTranslate } from './mock/translations';
import { TranslationBar } from './components/TranslationBar';
import { translationStore, useTranslationsFor } from './state/translationStore';
import { useTranslationSettings } from './state/translationSettings';
import { canvasHasInk } from './pdf/canvasUtils';
import {
  extractPageItems,
  loadPdf,
  renderPageToCanvas,
  renderPageToOffscreen,
} from './pdf/pdfjsAdapter';
import { extractPathBoxes } from './pdf/vectorGraphics';
import type { BBox, Block, PageAnalysis, Segment } from './types';

/** 原版式视图里译文与原文段落下缘的间距 */
const OVERLAY_GAP = 2;
const BASE_SCALE = 1.5;

/**
 * 从 PDF 提取论文标题，用于论文库侧边栏显示。
 *
 * ── 优先级 ──
 *  1. PDF 元数据 `info.Title`（最可靠，且能拿到「论文真实标题」而非文件名）；
 *  2. 首页探测：首页顶部字号最大的块（标题通常显著大于正文，见 frontMatter.ts）；
 *  3. 都失败 → 返回 null，调用方回退到文件名（去扩展名）。
 *
 * 注意：这里只负责「标题字符串」，首页作者/机构免译是 domain 层 `markFrontMatter`
 * 在渲染时处理的，两者职责不重叠。
 */
async function extractDocTitle(doc: any): Promise<string | null> {
  // 1. PDF 元数据
  try {
    const meta = await doc.getMetadata();
    const t = String((meta as any)?.info?.Title ?? '').trim();
    if (t && t.length <= 300) return t;
  } catch {
    // 元数据不可用（隐私模式等）时继续走首页探测
  }
  // 2. 首页探测
  try {
    const page = await doc.getPage(1);
    const extracted = await extractPageItems(page, 0, BASE_SCALE);
    const analysis = analyzePage({
      pageIndex: 0,
      width: extracted.width,
      height: extracted.height,
      items: extracted.items,
    });
    const title = findTitleBlock(analysis.blocks, extracted.height);
    if (title) return title.text.trim().slice(0, 300);
  } catch {
    // 首页解析失败则放弃
  }
  return null;
}
/** 正文 HTML 字号相对 PDF 正文字号的放大倍率（屏幕阅读比纸面需要更大字号） */
const FONT_BOOST = 1.25;
/** 稳定的空 Map —— 每次渲染都新建会让下游的 useMemo 白算 */
const EMPTY_TRANSLATIONS: ReadonlyMap<string, string> = new Map();

/**
 * 文档来源。
 *
 * 内置样本保留着 —— 它让「不挑文件就能验证渲染与算法」这件事继续成立，
 * 而这是整个项目里最常用的开发动作。用户打开的文件是实际使用的路径。
 */
type DocSource =
  | { kind: 'fixture'; label: string }
  | { kind: 'url'; label: string; url: string }
  | { kind: 'file'; label: string; data: ArrayBuffer }
  /** 论文库里的某一篇：二进制按需从 IndexedDB 取，不进 state */
  | { kind: 'library'; label: string; id: string; lastPage: number };

const FIXTURE_SOURCE: DocSource = { kind: 'fixture', label: '内置样本 · ResNet (CVPR 2016)' };

/**
 * `?pdf=<路径>` 可指定启动时加载的 PDF（相对站点根，如
 * `/fixtures/single-column-sample.pdf`）。
 *
 * 开发与无头验证用 —— 不挑文件就能让浏览器验证跑在任意样本上；
 * 正常使用仍然走「打开 PDF」按钮或拖放。
 */
function initialDocSource(): DocSource {
  const pdf = new URLSearchParams(window.location.search).get('pdf');
  if (!pdf) return FIXTURE_SOURCE;
  const label = decodeURIComponent(pdf).split('/').pop() ?? pdf;
  return { kind: 'url', label, url: pdf };
}
/**
 * 判定「文字被图形夹住」时允许的最大距离（PDF 点）。
 * 表格行线紧贴文字（实测 2–3pt）；图形与正文之间的留白远大于此（实测 20pt+）。
 */
const FIGURE_MAX_DISTANCE = 3;

interface OverlayCheck {
  measured: number;
  overlapped: number;
  maxOverflowPx: number;
  medianTranslationHeight: number;
  medianAvailableGap: number;
}

type Status = 'loading' | 'ready' | 'error';
type ViewMode = 'flow' | 'overlay';

/**
 * 初始页码。支持 `?page=N`，便于自动化验证脚本直接定位到特定版式的页面
 * （不同页的图/表/双栏组合差别很大，只验一页说明不了问题）。
 */
function initialPageNumber(): number {
  const raw = new URLSearchParams(window.location.search).get('page');
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 4;
}

export default function App() {
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayContainerRef = useRef<HTMLDivElement | null>(null);
  const pdfRef = useRef<any>(null);
  const runIdRef = useRef(0);

  const [numPages, setNumPages] = useState(0);
  const [source, setSource] = useState<DocSource>(initialDocSource);
  /**
   * 论文库初始化是否完成。
   *
   * 文档加载 effect 必须等它 —— 启动恢复要在**任何加载开始之前**把
   * source 换成库里最近打开的论文，否则会先闪一下内置样本再切换。
   */
  const [libraryReady, setLibraryReady] = useState(false);
  /** 当前打开的论文在库中的 id（fixture / ?pdf= 打开的没有） */
  const [currentPaperId, setCurrentPaperId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** 拖放高亮。拖文件到窗口任意位置都能打开，不必先对准某个区域 */
  const [dragOver, setDragOver] = useState(false);
  /**
   * 诊断面板是否显示。
   *
   * 默认**关闭**：`分栏与段落`、`正文识别`这些是开发期的判据可观测性工具，
   * 不是阅读功能。放在默认界面上只会让人以为这是个调试工具。
   * 需要时用 `?debug=1` 打开。
   */
  const [showDiagnostics] = useState(
    () => new URLSearchParams(window.location.search).get('debug') === '1'
  );
  /** pdf.js 文档对象。用 state 而不是只用 ref —— 瀑布流要等它就绪后才渲染页面列表 */
  const [doc, setDoc] = useState<any>(null);
  const [pageNumber, setPageNumber] = useState(initialPageNumber);
  /**
   * 已解析到第几页。瀑布流靠它做**顺序加载**：第 N 页就绪才放开第 N+1 页。
   *
   * 不做并发是有原因的：pdf.js 对同一文档的并发页面请求本就会排队，
   * 而同时渲染十几页会瞬间吃掉几百 MB 内存（每页的离屏画布 + 切片画布都不小）。
   * 用户是自上而下读的，顺序加载正好匹配阅读节奏。
   */
  const [readyUpTo, setReadyUpTo] = useState(() => Math.max(0, initialPageNumber() - 1));
  /**
   * 每页处理完后的「是否处于参考文献区间」。
   *
   * 文献表常跨页，所以这个状态必须逐页串联：第 N 页的入状态 = 第 N-1 页的出状态。
   * 瀑布流是顺序加载的，等第 N-1 页就绪才放开第 N 页，所以这里能拿到完整的历史。
   */
  const [referenceStates, setReferenceStates] = useState<Map<number, boolean>>(new Map());
  /**
   * 文档级重排行宽基准：已就绪页面中最大的内容宽。
   *
   * 附录收尾页常常只有半栏内容，若按「本页内容宽」排行，
   * 行宽会缩成一半（用户看到的是「段落居中、没铺满」）。
   * 各页就绪时上报自己的内容宽，这里取历史最大值再传回去 ——
   * 行宽在文档内保持稳定。
   */
  const [docReadingWidth, setDocReadingWidth] = useState(0);
  const [scale, setScale] = useState(BASE_SCALE);
  const [status, setStatus] = useState<Status>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [analysis, setAnalysis] = useState<PageAnalysis | null>(null);
  const [report, setReport] = useState<SelfCheckReport | null>(null);
  const [offscreen, setOffscreen] = useState<HTMLCanvasElement | null>(null);
  /** 本页图形路径的包围盒，供文档流裁切与「图形覆盖」自检使用 */
  const [figurePaths, setFigurePaths] = useState<BBox[]>([]);
  /** 跨栏的图形区域：作为整体裁切，避免被栏缝劈成两半 */
  const [figureRegions, setSpanningFigures] = useState<BBox[]>([]);
  /**
   * 图形路径坐标的可信度：路径框里真的有墨迹的比例。
   *
   * 路径是绘图指令，画出来的框里必然有墨 —— 比例低就说明坐标算错了
   * （实测 CTM 追踪在第 1/2/3/6 页不准，第 4/5 页正常）。
   * 坐标不可信时宁可不做「图形区域补刀」，也不要拿错几何去判定文字。
   */
  const [geometryConfidence, setGeometryConfidence] = useState(1);
  // `?view=overlay` 直接以原版式打开 —— 排查「重排后与原文是否一致」时，
  // 需要一个能立刻切到原版式的入口，而不是手动点按钮
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    new URLSearchParams(window.location.search).get('view') === 'overlay' ? 'overlay' : 'flow'
  );

  const [overlayCheck, setOverlayCheck] = useState<OverlayCheck | null>(null);
  const [flowMeasure, setFlowMeasure] = useState<FlowMeasurement | null>(null);

  const [showItems, setShowItems] = useState(false);
  const [showBlocks, setShowBlocks] = useState(false);
  const [showColumns, setShowColumns] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  const handleMeasured = useCallback((m: FlowMeasurement) => setFlowMeasure(m), []);

  /** 打开本地 PDF */
  const openFile = useCallback(async (file: File) => {
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    if (!isPdf) {
      // 说清楚拒绝的原因，而不是默默什么都不做
      setError(`只支持 PDF 文件，收到的是「${file.name}」`);
      return;
    }
    try {
      const data = await file.arrayBuffer();
      setSource({ kind: 'file', label: file.name, data });
    } catch (e) {
      setError(`读取文件失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  /** 拖放打开：拖到窗口任意位置即可，不必对准某个区域 */
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      // relatedTarget 为 null 才说明真的离开了窗口 ——
      // 否则在子元素之间移动也会触发，高亮会不停闪烁
      if (e.relatedTarget === null) setDragOver(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) void openFile(file);
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [openFile]);

  /**
   * 某一页解析完成。
   *
   * 两个职责：放开下一页；把该页的数据交给调试面板
   * （面板只能显示一页的指标，就跟着最新解析完的那页走）。
   */
  const handlePageReady = useCallback((page: number, info: PageReadyInfo) => {
    setReadyUpTo((v) => (page > v ? page : v));
    setDocReadingWidth((w) => Math.max(w, info.analysis.contentBounds.width));
    setReferenceStates((prev) => {
      if (prev.get(page) === info.referencesActive) return prev;
      const next = new Map(prev);
      next.set(page, info.referencesActive);
      return next;
    });
    setAnalysis(info.analysis);
    setReport(selfCheck(info.analysis));
    setGeometryConfidence(info.geometryConfidence);
  }, []);

  /**
   * 瀑布流：页码跟随滚动。
   *
   * 连续滚动下「当前在第几页」不再由按钮决定，必须从滚动位置反推 ——
   * 否则工具栏会一直停在初始页码上，用户完全不知道自己读到哪了。
   *
   * 实现上是「取顶部已经越过视口上沿的最后一页」。用滚动事件而不是
   * IntersectionObserver：后者在一页跨越整个视口时（本项目的页动辄三五千像素高）
   * 会同时报告多个页相交，反而更难判断「当前页」。
   */
  useEffect(() => {
    if (viewMode !== 'flow' || numPages === 0) return;
    const viewport = document.querySelector('.viewport');
    if (!viewport) return;

    const syncFromScroll = () => {
      const viewportTop = viewport.getBoundingClientRect().top;
      let current = 1;
      for (let n = 1; n <= numPages; n += 1) {
        const el = document.querySelector(`[data-page="${n}"]`);
        if (!el) break;
        // 页顶越过视口上沿 60px 以上，就算「已经读到这一页」
        if (el.getBoundingClientRect().top - viewportTop < 60) current = n;
      }
      setPageNumber((v) => (v === current ? v : current));
    };

    viewport.addEventListener('scroll', syncFromScroll, { passive: true });
    // 页面高度会随各页陆续解析而增长，所以每次放开新页都重新对一次
    syncFromScroll();
    return () => viewport.removeEventListener('scroll', syncFromScroll);
  }, [viewMode, numPages, readyUpTo]);

  /**
   * `?page=N` 深链接：直接滚到该页。
   *
   * 没有这一段的话，`?page=4` 只会把加载进度放开到第 4 页，
   * 但视口仍停在第 1 页顶部 —— 深链接等于失效。
   */
  useEffect(() => {
    if (status !== 'ready' || viewMode !== 'flow') return;
    const target = pageNumber;
    if (target <= 1) return;
    const timer = window.setTimeout(() => {
      document.querySelector(`[data-page="${target}"]`)?.scrollIntoView({ block: 'start' });
    }, 900);
    return () => window.clearTimeout(timer);
    // 只在文档就绪时执行一次；后续跳页由 goToPage 负责滚动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, viewMode]);

  /** 跳页：瀑布流下滚到目标页，并放开它的加载 */
  const goToPage = useCallback(
    (target: number) => {
      const clamped = Math.max(1, Math.min(numPages || 1, target));
      setPageNumber(clamped);
      // 阅读位置持久化 —— 关掉应用再回来能回到这一页。
      // IndexedDB 小写入很便宜，不值得为此做防抖
      if (currentPaperId) void libraryStore.setProgress(currentPaperId, clamped);
      if (viewMode !== 'flow') return;
      setReadyUpTo((v) => (clamped - 1 > v ? clamped - 1 : v));
      // 目标页的 section 即便还没解析也已经存在（占位），所以可以立刻滚过去
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-page="${clamped}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },
    [numPages, viewMode, currentPaperId]
  );

  /** 从侧边栏打开一篇库里的论文 */
  const openFromLibrary = useCallback((meta: PaperMeta) => {
    setSource({ kind: 'library', label: meta.title, id: meta.id, lastPage: meta.lastPage });
  }, []);

  /** 从库里删除。正在读的那篇被删掉时回到内置样本，不能悬空 */
  const removeFromLibrary = useCallback(
    (meta: PaperMeta) => {
      void libraryStore.remove(meta.id);
      setCurrentPaperId((current) => {
        if (current === meta.id) {
          setSource((src) => (src.kind === 'library' && src.id === meta.id ? { kind: 'fixture', label: '内置样本 · ResNet (CVPR 2016)' } : src));
          return null;
        }
        return current;
      });
    },
    []
  );

  // ── 译文来源：段落级缓存 + 真实模型（见 state/translationStore.ts）──
  // 这里只负责「原版式」视图与调试面板；瀑布流的每一页各取自己那几个块，
  // 避免一段译文到达就让所有已加载页重渲染。
  const overlayBlockIds = useMemo(
    () =>
      analysis
        ? analysis.blocks.filter((b) => b.isBodyText && b.translatable).map((b) => b.id)
        : [],
    [analysis]
  );

  useEffect(() => {
    if (!analysis) return;
    translationStore.register(
      analysis.blocks
        .filter((b) => b.isBodyText && b.translatable)
        .map((b) => ({ id: b.id, text: b.text }))
    );
  }, [analysis]);

  const realTranslations = useTranslationsFor(overlayBlockIds);
  const { previewMode } = useTranslationSettings();

  const translations = useMemo(() => {
    if (!analysis) return EMPTY_TRANSLATIONS;
    if (!previewMode) return realTranslations;
    const map = new Map<string, string>();
    for (const block of analysis.blocks) {
      if (!block.isBodyText) continue;
      map.set(block.id, realTranslations.get(block.id) ?? mockTranslate(block.text));
    }
    return map;
  }, [analysis, realTranslations, previewMode]);

  // 注入「该区域有没有墨水」的判断：纯空白的填充区不生成图像节点，间距交给 CSS
  const hasContent = useCallback(
    (bbox: BBox) => (offscreen ? canvasHasInk(offscreen, bbox) : true),
    [offscreen]
  );

  const flow: PageFlow | null = useMemo(() => {
    if (!analysis) return null;
    return buildPageFlow(analysis, translations, { hasContent, figurePaths, figureRegions });
  }, [analysis, translations, hasContent, figurePaths, figureRegions]);

  const segments: Segment[] = useMemo(() => {
    if (!analysis) return [];
    return analysis.segments.map((s) => ({
      ...s,
      translation: translations.get(s.blockIds[0]) ?? null,
    }));
  }, [analysis, translations]);

  // ── 论文库初始化 + 启动恢复 ──
  useEffect(() => {
    let cancelled = false;
    void libraryStore.init().then(() => {
      if (cancelled) return;
      // `?pdf=` 是开发/验证用的显式指定，优先于启动恢复
      const explicit = new URLSearchParams(window.location.search).get('pdf');
      const last = libraryStore.lastOpened();
      if (!explicit && last) {
        setSource({ kind: 'library', label: last.title, id: last.id, lastPage: last.lastPage });
      }
      setLibraryReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── 加载文档（跟随 source 变化）──
  useEffect(() => {
    // 等论文库初始化完 —— 否则启动恢复来不及把 source 换成库里的论文
    if (!libraryReady) return;
    let cancelled = false;
    setStatus('loading');
    setError('');

    // 恢复的论文从上次读到的页开始；其余从 ?page= 或第 1 页开始
    const startPage = source.kind === 'library' ? source.lastPage : initialPageNumber();
    pdfRef.current = null;
    setDoc(null);
    setNumPages(0);
    setPageNumber(startPage);
    setReadyUpTo(Math.max(0, startPage - 1));
    setReferenceStates(new Map());
    setDocReadingWidth(0);
    // 关键：块 id 不含内容，不清空会把上一份文档的译文显示到新文档上
    translationStore.reset();

    (async () => {
      try {
        // ArrayBuffer 要复制一份再交给 pdf.js —— 它会 transfer 掉传入的缓冲区，
        // 同一个 buffer 再用一次就会拿到空数据
        const payload =
          source.kind === 'fixture'
            ? fixtureUrl
            : source.kind === 'url'
              ? source.url
              : source.kind === 'library'
                ? ((await libraryStore.getFileData(source.id)) ?? '')
                : source.data.slice(0);
        const doc = await loadPdf(payload);
        if (cancelled) return;
        pdfRef.current = doc;
        setDoc(doc);
        setNumPages(doc.numPages);
        setStatus('ready');

        // 用户打开的文件顺手入库 —— 之后从侧边栏就能回到这篇
        if (source.kind === 'file') {
          // 取真实标题（PDF 元数据优先，回退首页探测，再回退文件名）
          const realTitle =
            (await extractDocTitle(doc)) ?? source.label.replace(/\.pdf$/i, '');
          const meta = await libraryStore.add({
            title: realTitle,
            fileName: source.label,
            byteLength: source.data.byteLength,
            pageCount: doc.numPages,
            data: source.data,
          });
          if (cancelled) return;
          setCurrentPaperId(meta.id);
          // 库里已有这篇的阅读进度（重复打开）→ 恢复到上次的位置
          if (meta.lastPage > 1 && meta.lastPage <= doc.numPages) {
            setPageNumber(meta.lastPage);
            setReadyUpTo(Math.max(0, meta.lastPage - 1));
          }
        } else if (source.kind === 'library') {
          setCurrentPaperId(source.id);
        } else {
          setCurrentPaperId(null);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
    // libraryReady 必须在依赖里：守卫 return 之后，靠它从 false → true 触发真正的加载
  }, [source, libraryReady]);

  // ── 渲染 + 提取 + 分析 ──
  useEffect(() => {
    // 重排视图已经交给瀑布流（每个 PageFlowBlock 各自负责一页），
    // 这个单页流水线只服务「原版式」视图与调试面板。
    if (viewMode !== 'overlay') return;
    if (status !== 'ready' || !pdfRef.current) return;
    const runId = ++runIdRef.current;
    let cancelled = false;
    setBusy(true);

    (async () => {
      try {
        const page = await pdfRef.current.getPage(pageNumber);
        if (cancelled || runId !== runIdRef.current) return;

        const off = await renderPageToOffscreen(page, scale);
        if (cancelled || runId !== runIdRef.current) return;

        const canvas = overlayCanvasRef.current;
        if (canvas) await renderPageToCanvas(page, canvas, scale);
        if (cancelled || runId !== runIdRef.current) return;

        const extracted = await extractPageItems(page, pageNumber - 1, scale);
        if (cancelled || runId !== runIdRef.current) return;

        // 图形区域（矢量路径聚类）—— 用来判定「字号模糊区间」的块是否属于图内文字
        const rawPaths = await extractPathBoxes(page, scale);
        if (cancelled || runId !== runIdRef.current) return;

        // 坐标可信度自检：路径框里应当有墨迹。
        //
        // 探测前先把框外扩几像素 —— 路径框常常只有 1px 宽（细线），
        // 而采样是每 4 个像素取一个点，竖线很容易被整条跳过，
        // 于是坐标本来正确的页面也会被判成不可信（实测第 5 页因此被误判为 16%）。
        const PATH_PROBE_PAD = 3;
        const inked = rawPaths.filter((box) =>
          canvasHasInk(
            off,
            {
              x: box.x - PATH_PROBE_PAD,
              y: box.y - PATH_PROBE_PAD,
              width: box.width + PATH_PROBE_PAD * 2,
              height: box.height + PATH_PROBE_PAD * 2,
            },
            236
          )
        ).length;
        const confidence = rawPaths.length === 0 ? 1 : inked / rawPaths.length;
        const trusted = confidence >= 0.5;

        const paths = trusted ? figurePathBoxes(rawPaths) : [];

        const result = analyzePage({
          pageIndex: pageNumber - 1,
          width: extracted.width,
          height: extracted.height,
          items: extracted.items,
          options: {
            // 只在字号判不出来的模糊区间会被调用。用的是图形自身的几何边界，
            // 与渲染缩放无关，因此结果稳定、不随缩放漂移。
            rawPaths,
            isInsideFigure: (bbox) =>
              isEnclosedByGraphics(bbox, paths, FIGURE_MAX_DISTANCE * scale),
          },
        });
        if (cancelled || runId !== runIdRef.current) return;

        setAnalysis(result);
        setReport(selfCheck(result));
        setOffscreen(off);
        // 文字表格矩形并入切片几何（I17）：表格没有矢量路径，
        // 不并入则空隙切图不发生 —— 与位图框（I13）同一类坑
        setFigurePaths(paths.concat(result.tableRegions.map((t) => t.bbox)));
        setGeometryConfidence(confidence);

        // 图形区域统一取域层算好的那份（路径簇 + 位图框 + 表格矩形，
        // 已扩展到包住图内文字）。跨栏判定交给 pageFlow 的域层逻辑 ——
        // 这里自己再筛一遍「跨栏」等于把同一份几何算两遍，迟早漂移。
        setSpanningFigures(result.figureRegions);
        setBusy(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
        setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status, pageNumber, scale]);

  // ── 原版式视图的重叠测量（仅用于和 I0 对照）──
  useLayoutEffect(() => {
    if (viewMode !== 'overlay' || !analysis || segments.length === 0) return;
    const container = overlayContainerRef.current;
    if (!container) return;

    const byColumn = new Map<number, Block[]>();
    for (const block of analysis.blocks) {
      const list = byColumn.get(block.columnIndex) ?? [];
      list.push(block);
      byColumn.set(block.columnIndex, list);
    }
    for (const list of byColumn.values()) list.sort((a, b) => a.readOrder - b.readOrder);

    const heights: number[] = [];
    const gaps: number[] = [];
    let measured = 0;
    let overlapped = 0;
    let maxOverflow = 0;

    for (const segment of segments) {
      const el = container.querySelector<HTMLElement>(`[data-segment="${segment.id}"]`);
      if (!el) continue;
      const block = analysis.blocks.find((b) => b.id === segment.blockIds[0]);
      if (!block) continue;
      const column = byColumn.get(block.columnIndex) ?? [];
      const index = column.findIndex((b) => b.id === block.id);
      const next = column[index + 1];

      const height = el.offsetHeight;
      measured += 1;
      heights.push(height);
      if (!next) continue;

      const available = next.bbox.y - (block.bbox.y + block.bbox.height);
      gaps.push(available);
      const overflow = height - available;
      if (overflow > 0) {
        overlapped += 1;
        if (overflow > maxOverflow) maxOverflow = overflow;
      }
    }

    const median = (values: number[]) => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    };

    setOverlayCheck({
      measured,
      overlapped,
      maxOverflowPx: Math.round(maxOverflow),
      medianTranslationHeight: Math.round(median(heights)),
      medianAvailableGap: Math.round(median(gaps)),
    });
  }, [viewMode, analysis, segments, scale, collapsed]);

  const overlayFontSize = (report?.medianFontSize ?? 10) * 0.92;
  const flowFontSize = (analysis?.bodyFontSize ?? 10) * FONT_BOOST;

  return (
    <div className="app">
      {/* 拖放高亮：覆盖整窗，明确告诉用户「松手就会打开」 */}
      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-hint">松开即可打开这篇 PDF</div>
        </div>
      )}

      <header className="toolbar">
        {/* 应用标识 + 当前文档。工具栏里最该先被看到的是「我在读哪篇」 */}
        <div className="brand">
          <span className="brand-name">论文阅读器</span>
          <span className="doc-name" title={source.label}>
            {source.label}
          </span>
        </div>

        <div className="group">
          <button
            type="button"
            className={sidebarOpen ? 'is-active' : ''}
            onClick={() => setSidebarOpen((v) => !v)}
            title="显示 / 隐藏论文库"
          >
            论文库
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()} title="打开本地 PDF（也可以直接把文件拖进窗口）">
            打开 PDF
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void openFile(file);
              // 清空 value，否则连续打开同一个文件不会触发 change
              e.target.value = '';
            }}
          />
        </div>

        <div className="group">
          <button type="button" disabled={pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}>
            上一页
          </button>
          <span className="page-indicator">
            {pageNumber} / {numPages || '—'}
            {viewMode === 'flow' && numPages > 0 && readyUpTo < numPages && (
              <span className="hint"> · 已解析 {readyUpTo}</span>
            )}
          </span>
          <button
            type="button"
            disabled={numPages === 0 || pageNumber >= numPages}
            onClick={() => goToPage(pageNumber + 1)}
          >
            下一页
          </button>
        </div>

        <div className="group">
          {[1.0, 1.5, 2.0].map((s) => (
            <button
              key={s}
              type="button"
              className={Math.abs(scale - s) < 0.001 ? 'active' : ''}
              onClick={() => {
                setScale(s);
                // 只放开到当前页。若不收回，已解析的每一页都会同时重渲染 ——
                // 十几页并发的离屏画布 + 切片画布，内存开销很可观。
                setReadyUpTo(Math.max(0, pageNumber - 1));
              }}
            >
              {Math.round(s * 100)}%
            </button>
          ))}
        </div>

        <div className="group">
          <button type="button" className={viewMode === 'flow' ? 'active' : ''} onClick={() => setViewMode('flow')}>
            重排对照
          </button>
          <button
            type="button"
            className={viewMode === 'overlay' ? 'active' : ''}
            onClick={() => setViewMode('overlay')}
          >
            原版式
          </button>
        </div>

        {viewMode === 'overlay' && (
          <div className="group">
            <label>
              <input type="checkbox" checked={showBlocks} onChange={(e) => setShowBlocks(e.target.checked)} />
              段落框
            </label>
            <label>
              <input type="checkbox" checked={showItems} onChange={(e) => setShowItems(e.target.checked)} />
              文本项框
            </label>
            <label>
              <input type="checkbox" checked={showColumns} onChange={(e) => setShowColumns(e.target.checked)} />
              栏缝
            </label>
            <label>
              <input type="checkbox" checked={collapsed} onChange={(e) => setCollapsed(e.target.checked)} />
              折叠译文
            </label>
          </div>
        )}

        {busy && <span className="page-indicator">处理中…</span>}

        {/* 翻译是整篇文档的动作，不是每页独立的事 —— 所以工具栏放在瀑布流外层 */}
        <TranslationBar />
      </header>

      <div className="app-body">
      {/* 诊断面板：默认不显示，`?debug=1` 才出现（见 showDiagnostics 的注释） */}
      <section className="report" hidden={!showDiagnostics}>
        <div className="report-card">
          <h3>分栏与段落</h3>
          {report ? (
            <ul>
              <li>
                文本项 {report.itemCount} · 行 {report.lineCount} · 段 {report.blockCount}
              </li>
              <li>
                栏数 <strong>{report.columnCount}</strong> · 越栏块{' '}
                <strong className={report.outOfColumnBlocks ? 'bad' : 'ok'}>{report.outOfColumnBlocks}</strong> ·
                行内重叠 <strong className={report.lineOverlapCount ? 'warn' : 'ok'}>{report.lineOverlapCount}</strong>
              </li>
            </ul>
          ) : (
            <p>加载中…</p>
          )}
        </div>

        <div className="report-card">
          <h3>正文识别</h3>
          {analysis ? (
            <ul>
              <li>
                正文字号 <strong>{analysis.bodyFontSize.toFixed(1)}</strong> px
              </li>
              <li>
                正文段 <strong>{analysis.bodyBlockCount}</strong> / {analysis.blocks.length} 段
                {analysis.blocks.length > 0 && (
                  <>
                    {' '}
                    （{Math.round((analysis.bodyBlockCount / analysis.blocks.length) * 100)}%）
                  </>
                )}
              </li>
              <li className="hint">其余段落判定为图内文字，整体保留为图像不翻译</li>
              <li>
                图形坐标可信度{' '}
                <strong className={geometryConfidence < 0.5 ? 'bad' : 'ok'}>
                  {Math.round(geometryConfidence * 100)}%
                </strong>
                {geometryConfidence < 0.5 && <span className="bad"> · 已停用图形判定</span>}
              </li>
              {/*
                扫描版 PDF 的探测。整页一个文本项都没有，说明这一页根本没有文本层
                （内容是位图扫描件），此时重排与翻译都无从谈起。
                明确说出来，好过让用户对着空白页面猜为什么没反应。
              */}
              {analysis.items.length === 0 && (
                <li className="bad">
                  本页没有文本层 —— 可能是扫描版 PDF。当前版本不支持 OCR，只能以原版式查看。
                </li>
              )}
            </ul>
          ) : (
            <p>加载中…</p>
          )}
        </div>

        <div className="report-card">
          <h3>重排结果</h3>
          {flowMeasure && flow ? (
            <ul>
              <li>
                可选中段落 <strong className="ok">{flowMeasure.selectableParagraphs}</strong> · 图像切片{' '}
                {flowMeasure.sliceCount}
              </li>
              <li>
                内容高度 {flowMeasure.totalHeight}px · 撑开 <strong>{flowMeasure.stretchRatio}×</strong>
              </li>
              <li>
                空切片 <strong className={flowMeasure.emptySlices ? 'bad' : 'ok'}>{flowMeasure.emptySlices}</strong>
              </li>
            </ul>
          ) : (
            <p>等待渲染…</p>
          )}
        </div>

        <div className="report-card">
          <h3>I0 原版式对照</h3>
          {overlayCheck ? (
            <ul>
              <li>
                压住下一段{' '}
                <strong className={overlayCheck.overlapped ? 'bad' : 'ok'}>{overlayCheck.overlapped}</strong> /{' '}
                {overlayCheck.measured}
              </li>
              <li>最大溢出 {overlayCheck.maxOverflowPx} px</li>
              <li className="hint">重排视图不存在此问题——译文在文档流里，不覆盖原文</li>
            </ul>
          ) : (
            <p>切到「原版式」后测量</p>
          )}
        </div>
      </section>

      {sidebarOpen && (
        <LibrarySidebar currentId={currentPaperId} onOpen={openFromLibrary} onDelete={removeFromLibrary} />
      )}

      <main className="viewport">
        {status === 'error' && <div className="error">加载失败：{error}</div>}
        {status === 'loading' && <div className="loading">正在加载 PDF…</div>}

        {viewMode === 'flow' && doc && numPages > 0 && (
          <div className="paper paper-flow">
            {/* 瀑布流：全部页面依次排列，向下滚动即可连续阅读，
                不必再一页页点「下一页」。每页只在自己的 enabled 为真时才开始解析。 */}
            {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
              <PageFlowBlock
                // key 带上 scale：切换缩放意味着「以新的分辨率重新渲染」，
                // 必须重建区块（组件内部对同一页只加载一次，是有意为之）。
                key={`${n}-${scale}`}
                doc={doc}
                pageNumber={n}
                scale={scale}
                enabled={n <= readyUpTo + 1}
                baseFontSize={flowFontSize}
                // 入状态 = 上一页的出状态。文献区间由此跨页延续。
                referencesActive={referenceStates.get(n - 1) ?? false}
                docReadingWidth={docReadingWidth}
                onReady={handlePageReady}
                onMeasured={handleMeasured}
              />
            ))}
          </div>
        )}

        <div
          ref={overlayContainerRef}
          className="paper"
          style={{ display: viewMode === 'overlay' ? 'block' : 'none', position: 'relative' }}
        >
          <canvas ref={overlayCanvasRef} className="pdf-canvas" />
          {analysis && viewMode === 'overlay' && (
            <>
              <DebugLayer
                analysis={analysis}
                showItems={showItems}
                showBlocks={showBlocks}
                showColumns={showColumns}
              />
              <div style={{ fontSize: overlayFontSize }}>
                <ParallelLayer segments={segments} gap={OVERLAY_GAP} visible collapsed={collapsed} />
              </div>
            </>
          )}
        </div>
      </main>
      </div>
    </div>
  );
}
