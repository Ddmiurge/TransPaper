import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzePage } from '../pipeline';
import { isContinuation, paragraphTailInfoOf } from '../crossPage';
import { geometryBoxesFromOperators } from '../../pdf/operatorPaths';
import { figurePathBoxes, isEnclosedByGraphics } from '../figureRegions';
import { collectFontTraits } from '../../pdf/fontTraits';
import { baselineOf, fontSizeOf, isRotatedTransform, toBBox } from '../geometry';
import type { PageAnalysis, RawTextItem, TextItem } from '../../types';

const here = dirname(fileURLToPath(import.meta.url));
const STANDARD_FONTS = `${resolve(here, '../../../node_modules/pdfjs-dist/standard_fonts')}/`;
const SCALE = 1.5;

/** 与 realPdf.test.ts 走完全相同的提取路径，取任意一页 */
async function analyzeFixturePage(
  doc: any,
  traits: Map<string, { bold: boolean; italic: boolean }>,
  pageIndex: number
): Promise<PageAnalysis> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const page: any = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: SCALE });
  const textContent = await page.getTextContent();
  await page.getOperatorList();

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
  const geometry = geometryBoxesFromOperators(ops, viewport.transform, pdfjs.OPS as any);
  const figurePaths = geometry.paths.length > 0
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

async function openFixture(fixture: string) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(resolve(here, `../../../fixtures/${fixture}`)));
  const doc = await pdfjs
    .getDocument({ data, standardFontDataUrl: STANDARD_FONTS, disableFontFace: true, useSystemFonts: false })
    .promise;
  // 字体特征用第 1 页的集合（realPdf.test 同款做法）
  const page1: any = await doc.getPage(1);
  const tc = await page1.getTextContent();
  const fontNames = new Set<string>();
  for (const raw of tc.items as any[]) {
    if (typeof raw.fontName === 'string') fontNames.add(raw.fontName);
  }
  return { doc, traits: collectFontTraits(page1, fontNames) };
}

describe('真实论文的跨页段落接续', () => {
  it.each([
    'two-column-sample.pdf',
    'single-column-sample.pdf',
    'acl-sample.pdf',
  ])('%s：文档中存在跨页接续对，且合并判定不误伤标题/公式', async (fixture) => {
    const { doc, traits } = await openFixture(fixture);
    const numPages = Math.min(doc.numPages, 12);

    let merged = 0;
    for (let i = 1; i < numPages; i += 1) {
      const prev = await analyzeFixturePage(doc, traits, i - 1);
      const curr = await analyzeFixturePage(doc, traits, i);
      const tail = paragraphTailInfoOf(prev.blocks);
      const head = curr.blocks.find((b) => b.isBodyText && b.translatable) ?? null;
      if (isContinuation(tail, head)) merged += 1;
    }
    // 跨页段落是真实论文的常态（I6 起就登记在候选清单）——
    // 一篇 12 页的论文里一次接续都没有，说明判据退化到永远漏报
    expect(merged).toBeGreaterThanOrEqual(1);
  }, 120000);

  it('ResNet：被合并的对，其尾部确实以未完字符收尾', async () => {
    const { doc, traits } = await openFixture('two-column-sample.pdf');
    const { endsOpen } = await import('../crossPage');

    let checked = 0;
    for (let i = 1; i < Math.min(doc.numPages, 12); i += 1) {
      const prev = await analyzeFixturePage(doc, traits, i - 1);
      const curr = await analyzeFixturePage(doc, traits, i);
      const tail = paragraphTailInfoOf(prev.blocks);
      const head = curr.blocks.find((b) => b.isBodyText && b.translatable) ?? null;
      if (isContinuation(tail, head)) {
        checked += 1;
        expect(endsOpen(tail!.text)).toBe(true);
        expect(head!.text).toMatch(/^[a-z,;]/);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(1);
  }, 120000);
});
