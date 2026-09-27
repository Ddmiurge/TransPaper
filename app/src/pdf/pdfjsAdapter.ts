// 必须在 pdf.js 之前：WKWebView 缺少它依赖的较新 Map 方法（见该文件注释）
import '../infra/webkitPolyfills';

import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { baselineOf, fontSizeOf, isRotatedTransform, toBBox } from '../domain/geometry';
import type { Matrix } from '../domain/matrix';
import type { BBox, RawTextItem, TextItem } from '../types';
import { collectFontTraits } from './fontTraits';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * 环境探测：把「pdf.js 能不能正常干活」的前置条件逐个试一遍。
 *
 * ── 为什么需要 ──
 * 打包后的桌面应用跑在 `tauri://` 自定义协议下，而 WebKit 对自定义协议
 * 的 Worker / 范围请求支持与 http 并不一致 —— 一旦 worker 起不来，
 * pdf.js 会静默退化成主线程解析：表现就是「第一页失败、后面几页极慢」。
 * 界面上只显示一句「解析失败」，根本看不出是哪一环，所以主动探测并落日志。
 */
export async function probePdfEnvironment(): Promise<string> {
  const parts: string[] = [`origin=${window.location.origin}`, `href=${window.location.href}`];

  try {
    const res = await fetch(workerUrl, { method: 'GET' });
    parts.push(`fetchWorker=${res.status}/${(await res.arrayBuffer()).byteLength}B`);
  } catch (e) {
    parts.push(`fetchWorker=FAIL(${e instanceof Error ? e.message : String(e)})`);
  }

  try {
    const w = new Worker(workerUrl);
    w.terminate();
    parts.push('newWorker=ok');
  } catch (e) {
    parts.push(`newWorker=FAIL(${e instanceof Error ? e.message : String(e)})`);
  }

  return parts.join(' | ');
}

/** worker 地址，供探测与诊断使用 */
export { workerUrl as PDF_WORKER_URL };

export interface PageRenderResult {
  items: TextItem[];
  width: number;
  height: number;
}

/**
 * 加载 PDF。
 *
 * 支持两种来源：
 *   - **URL**：内置样本（`fixtures/*.pdf?url`），开发与验证用
 *   - **二进制**：用户从磁盘选的文件（`ArrayBuffer`）
 *
 * 用同一个函数而不是两个：pdf.js 的 `getDocument` 本身就接受这两种入参，
 * 拆成两个函数只会让调用方多一层分支。
 *
 * 注意 pdf.js 会**接管**传入的 ArrayBuffer（transfer 掉），不要复用同一个 buffer
 * 去加载两次 —— 第二次会拿到已被清空的缓冲区。
 */
export async function loadPdf(source: string | ArrayBuffer | Uint8Array) {
  const params = typeof source === 'string' ? { url: source } : { data: source };
  const doc = await pdfjsLib.getDocument(params).promise;
  return doc;
}

/**
 * 把整页渲染到一个**离屏** canvas（不进 DOM）。
 *
 * 文档流视图需要按区域裁切页面像素 —— 渲染一次、裁很多块，
 * 比每个切片单独调 page.render 快一个数量级。
 */
export async function renderPageToOffscreen(page: any, scale: number): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);

  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建离屏 canvas 上下文');

  await page.render({
    canvasContext: context,
    viewport,
    transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
  }).promise;

  return canvas;
}

/**
 * 提取一页的文本项并换算成 viewport 坐标。
 *
 * 这是 T0.3 的产物，也是整条链路最容易出错的一环 ——
 * 坐标错了之后所有验证都无效，所以 T0.4 的调试层必须在继续之前先看一遍。
 */
export async function extractPageItems(
  page: any,
  pageIndex: number,
  scale: number
): Promise<PageRenderResult> {
  const viewport = page.getViewport({ scale });
  const textContent = await page.getTextContent();
  const viewportTransform = viewport.transform as Matrix;
  const styles: Record<string, { fontFamily?: string }> = textContent.styles ?? {};

  // commonObjs 只有在算子列表被求值之后才填充，这里必须先触发一次。
  // 拿它换到真实的 PostScript 字体名，进而识别粗体 / 斜体。
  await page.getOperatorList();
  const fontNames = new Set<string>();
  for (const raw of textContent.items as any[]) {
    if (typeof raw.fontName === 'string') fontNames.add(raw.fontName);
  }
  const traits = collectFontTraits(page, fontNames);

  const items: TextItem[] = [];
  let n = 0;

  for (const raw of textContent.items as any[]) {
    if (typeof raw.str !== 'string') continue;
    if (!raw.str.trim()) continue;

    const item: RawTextItem = {
      str: raw.str,
      transform: raw.transform,
      width: raw.width,
      height: raw.height,
      fontName: String(raw.fontName ?? ''),
    };
    const bbox: BBox = toBBox(item, viewportTransform, scale);
    const trait = traits.get(item.fontName);

    items.push({
      id: `p${pageIndex}-i${n}`,
      str: item.str,
      bbox,
      baselineY: baselineOf(item, viewportTransform),
      fontSize: fontSizeOf(item, viewportTransform, scale),
      fontName: item.fontName,
      // fontFamily 是 pdf.js 归一化后的族名（serif/sans-serif/monospace），只有族信息
      fontFamily: styles[item.fontName]?.fontFamily ?? '',
      // 字重与字形来自真实 PostScript 名，见 pdf/fontTraits.ts
      bold: trait?.bold ?? false,
      italic: trait?.italic ?? false,
      rotated: isRotatedTransform(item.transform),
      columnIndex: -1,
    });
    n += 1;
  }

  return {
    items,
    width: viewport.width,
    height: viewport.height,
  };
}
