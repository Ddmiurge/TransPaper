import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzePage } from '../pipeline';
import { findTitleBlock } from '../frontMatter';
import { geometryBoxesFromOperators } from '../../pdf/operatorPaths';
import { figurePathBoxes, isEnclosedByGraphics } from '../figureRegions';
import { collectFontTraits } from '../../pdf/fontTraits';
import { baselineOf, fontSizeOf, isRotatedTransform, toBBox } from '../geometry';
import type { PageAnalysis, RawTextItem, TextItem } from '../../types';

const here = dirname(fileURLToPath(import.meta.url));
// 复用真实 PDF 测试脚手架的字体路径与缩放，确保结论对生产有效
const STANDARD_FONTS = `${resolve(here, '../../../node_modules/pdfjs-dist/standard_fonts')}/`;
const SCALE = 1.5;

/** 与 realPdf.test.ts 走完全相同的提取路径，只取第 1 页 */
async function analyzePage1(fixture: string): Promise<PageAnalysis> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(resolve(here, `../../../fixtures/${fixture}`)));
  const doc = await pdfjs
    .getDocument({ data, standardFontDataUrl: STANDARD_FONTS, disableFontFace: true, useSystemFonts: false })
    .promise;
  const page: any = await doc.getPage(1);
  const viewport = page.getViewport({ scale: SCALE });
  const textContent = await page.getTextContent();
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
    const ri: RawTextItem = {
      str: raw.str,
      transform: raw.transform,
      width: raw.width,
      height: raw.height,
      fontName: String(raw.fontName ?? ''),
    };
    items.push({
      id: `p0-i${n}`,
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
  const geometry = geometryBoxesFromOperators(ops, viewport.transform, pdfjs.OPS as any);
  const rawPaths = geometry.paths;
  const rawImages = geometry.images;
  const figurePaths = rawPaths.length > 0 ? figurePathBoxes(rawPaths).concat(rawImages) : rawImages;

  return analyzePage({
    pageIndex: 0,
    width: viewport.width,
    height: viewport.height,
    items,
    options: {
      rawPaths,
      rawImages,
      isInsideFigure: (bbox) => isEnclosedByGraphics(bbox, figurePaths, 3 * SCALE),
    },
  });
}

describe('真实首页 front-matter 标记', () => {
  it('ResNet（双栏）：作者块标记 authors，标题与 Abstract 保持可译', async () => {
    const analysis = await analyzePage1('two-column-sample.pdf');

    const title = findTitleBlock(analysis.blocks, analysis.height)!;
    expect(title.text).toContain('Deep Residual Learning');
    expect(title.translatable).toBe(true);

    const authors = analysis.blocks.filter((b) => /Kaiming He|Shaoqing Ren/.test(b.text));
    expect(authors.length).toBeGreaterThan(0);
    for (const a of authors) {
      expect(a.nonTranslatableReason).toBe('authors');
      expect(a.translatable).toBe(false);
    }

    const abstract = analysis.blocks.find((b) => /^Abstract$/i.test(b.text.trim()));
    expect(abstract?.translatable).toBe(true);
  }, 60000);

  it('单栏样本：作者/机构块标记 authors，标题与 ABSTRACT 保持可译', async () => {
    const analysis = await analyzePage1('single-column-sample.pdf');

    const title = findTitleBlock(analysis.blocks, analysis.height)!;
    expect(title.fontScale).toBeGreaterThanOrEqual(1.3);
    expect(title.translatable).toBe(true);

    const authors = analysis.blocks.filter(
      (b) =>
        /Jianshuo Dong|Xiaoping Zhang|Tsinghua|Microsoft/.test(b.text) &&
        b.nonTranslatableReason === 'authors'
    );
    expect(authors.length).toBeGreaterThan(0);
    for (const a of authors) {
      expect(a.translatable).toBe(false);
      expect(a.nonTranslatableReason).toBe('authors');
    }

    const abstract = analysis.blocks.find((b) => /^ABSTRACT/i.test(b.text.trim()));
    expect(abstract?.translatable).toBe(true);
  }, 60000);
});
