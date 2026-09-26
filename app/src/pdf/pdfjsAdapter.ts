import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { baselineOf, fontSizeOf, isRotatedTransform, toBBox } from '../domain/geometry';
import type { Matrix } from '../domain/matrix';
import type { BBox, RawTextItem, TextItem } from '../types';
import { collectFontTraits } from './fontTraits';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

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
