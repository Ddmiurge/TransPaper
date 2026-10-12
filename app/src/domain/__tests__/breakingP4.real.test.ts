import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { analyzePage } from '../pipeline';
import { geometryBoxesFromOperators } from '../../pdf/operatorPaths';
import { figurePathBoxes, isEnclosedByGraphics } from '../figureRegions';
import { collectFontTraits } from '../../pdf/fontTraits';
import { baselineOf, fontSizeOf, isRotatedTransform, toBBox } from '../geometry';
import type { PageAnalysis, RawTextItem, TextItem } from '../../types';

const STANDARD_FONTS = `${resolve(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts')}/`;
const SCALE = 1.5;
const PDF = resolve(
  homedir(),
  'Library/Application Support/com.ddmiurge.transpaper/paper-files/14e8304a-9cad-408e-9e32-0494b8dc9e4f.pdf'
);

/**
 * 《Breaking Multimodal LLM Safety via Video-Driven Prompting》第 4 页的回归守护。
 *
 * 症状（用户报告「第四页识别不正常」）：整页 30 个 block 的 isBodyText 全为 false，
 * 正文一个字都不出现在重排结果里。
 *
 * 根因：pdf.js 对 matplotlib 柱状图的 `save → clip → constructPath → restore`
 * 结构给出的 minMax 含污染值（y 最小值 -7946.57，同值在同页重复 4 次）。
 * 过 CTM 与视口变换后，8 条柱子路径的包围盒变成 y=138–2702，而页高只有 1188
 * —— 穿透页面 2.3 倍。被污染的簇横跨整页，expandRegionsToText 顺着它吞掉所有
 * 邻近文字，remarkBodyBlocksInsideRegions 于是把整页正文标记为 graphics-region。
 *
 * 修复（两道防线）：
 *   1. operatorPaths.ts 的 geometryBoxesFromOperators 传入 pageSize，
 *      丢弃不完全落在页内的路径框（isFullyInsidePage）；
 *   2. figureRegions.ts 的 expandRegionsToText 把结果夹紧到页面内。
 *
 * 本文件把三条不变量钉住，任一条回退都会立刻失败。
 */
async function analyze(pageIndex: number): Promise<PageAnalysis> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(PDF));
  const doc: any = await pdfjs.getDocument({
    data,
    standardFontDataUrl: STANDARD_FONTS,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;
  const page: any = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: SCALE });
  const textContent = await page.getTextContent();
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
    const ri: RawTextItem = {
      str: raw.str,
      transform: raw.transform,
      width: raw.width,
      height: raw.height,
      fontName: String(raw.fontName ?? ''),
    };
    items.push({
      id: `p${pageIndex}-i${n}`,
      str: raw.str,
      bbox: toBBox(ri, viewport.transform, SCALE),
      baselineY: baselineOf(ri, viewport.transform),
      fontSize: fontSizeOf(ri, viewport.transform, SCALE),
      fontName: ri.fontName,
      fontFamily: (textContent.styles?.[ri.fontName]?.fontFamily) ?? '',
      bold: traits.get(ri.fontName)?.bold ?? false,
      italic: traits.get(ri.fontName)?.italic ?? false,
      rotated: isRotatedTransform(ri.transform),
      columnIndex: -1,
    });
    n += 1;
  }

  const ops = await page.getOperatorList();
  const geometry = geometryBoxesFromOperators(ops, viewport.transform, pdfjs.OPS as any, {
    width: viewport.width,
    height: viewport.height,
  });
  const figurePaths =
    geometry.paths.length > 0
      ? figurePathBoxes(geometry.paths).concat(geometry.images)
      : geometry.images;

  return analyzePage({
    pageIndex,
    width: viewport.width,
    height: viewport.height,
    items,
    options: {
      rawPaths: geometry.paths,
      rawImages: geometry.images,
      isInsideFigure: (bbox) => isEnclosedByGraphics(bbox, figurePaths, 3 * SCALE),
    },
  });
}

/** 打开文档并取第 1 页的字体特征（与 realPdf 测试同款做法） */
async function openDoc() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(PDF));
  return pdfjs.getDocument({
    data,
    standardFontDataUrl: STANDARD_FONTS,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;
}

describe('Breaking Multimodal · 第 4 页识别回归', () => {
  it('第 4 页：正文块不再被图形区域整页吞掉', async () => {
    const a = await analyze(3);

    // 症状本身就是 bodyBlockCount === 0 —— 整页无正文
    expect(a.bodyBlockCount).toBeGreaterThan(0);

    // 图 3 / 图 4 的说明文字与 3.3 / 3.4 两节标题必须回到正文流
    const bodyText = a.blocks.filter((b) => b.isBodyText).map((b) => b.text);
    expect(bodyText.some((t) => t.startsWith('Figure 3.'))).toBe(true);
    expect(bodyText.some((t) => t.startsWith('Figure 4.'))).toBe(true);
    expect(bodyText.some((t) => t.startsWith('3.3.'))).toBe(true);
    expect(bodyText.some((t) => t.startsWith('3.4.'))).toBe(true);
    expect(bodyText.some((t) => t.startsWith('4. Algorithm'))).toBe(true);
    expect(bodyText.some((t) => t.startsWith('4.1.'))).toBe(true);

    // 跨栏阅读顺序：左栏（3.x）必须整体早于右栏（4.x）
    const firstFour = bodyText.findIndex((t) => t.startsWith('4. Algorithm'));
    const lastThree = bodyText.map((t) => (t.startsWith('3.') ? 1 : 0)).lastIndexOf(1);
    expect(firstFour).toBeGreaterThan(lastThree);
  }, 120000);

  it('第 4 页：图形区域不穿透页面，且不覆盖正文段', async () => {
    const a = await analyze(3);
    for (const r of a.figureRegions) {
      expect(r.x).toBeGreaterThanOrEqual(-2);
      expect(r.y).toBeGreaterThanOrEqual(-2);
      expect(r.x + r.width).toBeLessThanOrEqual(a.width + 2);
      expect(r.y + r.height).toBeLessThanOrEqual(a.height + 2);
    }
    // 3.3 节的大段正文（y 615–955）不得被任何图形区域覆盖过半
    const para = a.blocks.find((b) => b.text.startsWith('Given that models'));
    expect(para).toBeDefined();
    expect(para!.isBodyText).toBe(true);
    const covered = a.figureRegions.some((r) => {
      const ix = Math.max(0, Math.min(r.x + r.width, para!.bbox.x + para!.bbox.width) - Math.max(r.x, para!.bbox.x));
      const iy = Math.max(0, Math.min(r.y + r.height, para!.bbox.y + para!.bbox.height) - Math.max(r.y, para!.bbox.y));
      return (ix * iy) / (para!.bbox.width * para!.bbox.height) >= 0.5;
    });
    expect(covered).toBe(false);
  }, 120000);

  it('第 4 页：图内小字标签仍是图内文字，不进入正文流', async () => {
    const a = await analyze(3);
    // Figure 4 的坐标轴刻度标签（fs ≈ 3.2–3.8，正文 15 的 0.2–0.25 倍）
    const axisLabels = a.blocks.filter((b) => /^(1\.01|Diverse|0\.98|0\.99) /.test(b.text));
    expect(axisLabels.length).toBeGreaterThan(0);
    for (const b of axisLabels) {
      expect(b.isBodyText).toBe(false);
      expect(b.figureReason).toBe('font-size');
    }
    // 页码仍保持「保留文本但不翻译」
    const pageNo = a.blocks.find((b) => /^\d{1,4}$/.test(b.text.trim()));
    expect(pageNo).toBeDefined();
    expect(pageNo!.translatable).toBe(false);
  }, 120000);

  it('全文 11 页：没有任何一页出现「正文全灭」', async () => {
    const doc = await openDoc();
    const pages = Math.min(doc.numPages, 11);
    for (let i = 0; i < pages; i += 1) {
      const a = await analyze(i);
      // 纯图页允许没有正文，但不得出现「区域穿透页面」
      for (const r of a.figureRegions) {
        expect(r.y + r.height).toBeLessThanOrEqual(a.height + 2);
        expect(r.x + r.width).toBeLessThanOrEqual(a.width + 2);
      }
      if (a.blocks.some((b) => b.isBodyText)) {
        // 有正文的页面，正文块必须占一定比例（图形标签页天然偏低，但不该是 0）
        expect(a.bodyBlockCount).toBeGreaterThan(0);
      }
    }
  }, 300000);
});
