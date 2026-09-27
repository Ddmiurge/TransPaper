import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { analyzePage } from '../pipeline';
import { maskInlineMath } from '../inlineMath';
import { figurePathBoxes, isEnclosedByGraphics } from '../figureRegions';
import { geometryBoxesFromOperators } from '../../pdf/operatorPaths';
import { collectFontTraits } from '../../pdf/fontTraits';
import { baselineOf, fontSizeOf, isRotatedTransform, toBBox } from '../geometry';
import type { PageAnalysis, RawTextItem, TextItem } from '../../types';

const here = dirname(fileURLToPath(import.meta.url));
const STANDARD_FONTS = `${resolve(here, '../../../node_modules/pdfjs-dist/standard_fonts')}/`;
const SCALE = 1.5;

/** 与 realPdf.test.ts 走完全相同的提取路径 */
async function analyzeOne(fixture: string, pageNum: number): Promise<PageAnalysis> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(resolve(here, `../../../fixtures/${fixture}`)));
  const doc = await pdfjs
    .getDocument({ data, standardFontDataUrl: STANDARD_FONTS, disableFontFace: true, useSystemFonts: false })
    .promise;
  const page: any = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: SCALE });
  const textContent = await page.getTextContent();
  await page.getOperatorList();
  const fontNames = new Set<string>();
  for (const raw of textContent.items as any[]) if (typeof raw.fontName === 'string') fontNames.add(raw.fontName);
  const traits = collectFontTraits(page, fontNames);
  const items: TextItem[] = [];
  let n = 0;
  for (const raw of textContent.items as any[]) {
    if (typeof raw.str !== 'string' || !raw.str.trim()) continue;
    const ri: RawTextItem = {
      str: raw.str, transform: raw.transform, width: raw.width, height: raw.height,
      fontName: String(raw.fontName ?? ''),
    };
    items.push({
      id: `p${pageNum - 1}-i${n}`, str: raw.str, bbox: toBBox(ri, viewport.transform, SCALE),
      baselineY: baselineOf(ri, viewport.transform), fontSize: fontSizeOf(ri, viewport.transform, SCALE),
      fontName: ri.fontName, fontFamily: (textContent.styles?.[ri.fontName]?.fontFamily) ?? '',
      bold: traits.get(ri.fontName)?.bold ?? false, italic: traits.get(ri.fontName)?.italic ?? false,
      rotated: isRotatedTransform(ri.transform), columnIndex: -1,
    });
    n += 1;
  }
  const ops = await page.getOperatorList();
  const geometry = geometryBoxesFromOperators(ops, viewport.transform, pdfjs.OPS as any);
  const rawPaths = geometry.paths;
  const rawImages = geometry.images;
  const figurePaths = rawPaths.length > 0 ? figurePathBoxes(rawPaths).concat(rawImages) : rawImages;
  return analyzePage({
    pageIndex: pageNum - 1, width: viewport.width, height: viewport.height, items,
    options: { rawPaths, rawImages, isInsideFigure: (bbox) => isEnclosedByGraphics(bbox, figurePaths, 3 * SCALE) },
  });
}

describe('行内公式占位 · 真实 PDF', () => {
  it('单栏样本（公式密集）能标出行内公式，且不出现「整段被占位」', async () => {
    const a = await analyzeOne('single-column-sample.pdf', 4);
    const body = a.blocks.filter((b) => b.isBodyText && b.translatable);
    let withMath = 0;
    let worstRatio = 1;

    for (const block of body) {
      const { masked, pieces } = maskInlineMath(block.text, block.spans);
      if (pieces.length === 0) continue;
      withMath += 1;
      // 占位后剩余的可译文字比例：太低说明判据把正文也圈进公式了
      const maskedChars = pieces.reduce((s, p) => s + p.text.length, 0);
      const ratio = 1 - maskedChars / Math.max(1, block.text.length);
      worstRatio = Math.min(worstRatio, ratio);
      expect(masked.length).toBeGreaterThan(0);
    }

    console.log(`p4 含行内公式的正文段 ${withMath} / ${body.length}，最低剩余文字比例 ${worstRatio.toFixed(2)}`);
    expect(withMath).toBeGreaterThan(0);
    // 至少保留一半文字交给翻译 —— 否则等于整段不译
    expect(worstRatio).toBeGreaterThan(0.5);
  }, 90000);

  it('双栏 ResNet 不产生行内公式误标（全篇纯文本段落为主）', async () => {
    const a = await analyzeOne('two-column-sample.pdf', 2);
    const body = a.blocks.filter((b) => b.isBodyText && b.translatable);
    for (const block of body) {
      const { pieces } = maskInlineMath(block.text, block.spans);
      const maskedChars = pieces.reduce((s, p) => s + p.text.length, 0);
      const ratio = 1 - maskedChars / Math.max(1, block.text.length);
      expect(ratio, `整段被判成公式: ${block.text.slice(0, 40)}`).toBeGreaterThan(0.5);
    }
  }, 90000);
});
