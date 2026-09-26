import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { analyzePage } from '../pipeline';
import { figurePathBoxes, isEnclosedByGraphics } from '../figureRegions';
import { geometryBoxesFromOperators } from '../../pdf/operatorPaths';
import { collectFontTraits } from '../../pdf/fontTraits';
import { baselineOf, fontSizeOf, isRotatedTransform, toBBox } from '../geometry';
import { EQ_NUMBER } from '../formulas';
import type { Block, PageAnalysis, RawTextItem, TextItem } from '../../types';

const here = dirname(fileURLToPath(import.meta.url));
const STANDARD_FONTS = `${resolve(here, '../../../node_modules/pdfjs-dist/standard_fonts')}/`;
const SCALE = 1.5;

/** 强运算符密度：数学符号里去掉单纯圆括号（与 formulas.ts 的判据一致） */
function strongDensity(text: string): number {
  let strong = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    total += 1;
    const c = ch.codePointAt(0) ?? 0;
    const isMath =
      (c >= 0x2200 && c <= 0x22ff) || (c >= 0x2a00 && c <= 0x2aff) ||
      (c >= 0x0370 && c <= 0x03ff) || (c >= 0x1d400 && c <= 0x1d7ff) ||
      (c >= 0x2100 && c <= 0x214f) || (c >= 0x2070 && c <= 0x209f) ||
      (c >= 0x2190 && c <= 0x21ff) ||
      c === 0x00b1 || c === 0x00d7 || c === 0x00f7 || c === 0x2202 ||
      c === 0x2207 || c === 0x2212 ||
      '=+<>{}'.includes(ch);
    if (isMath && ch !== '(' && ch !== ')') strong += 1;
  }
  return total > 0 ? strong / total : 0;
}

function longWords(text: string): number {
  const words = text.match(/[A-Za-z]{3,}/g) ?? [];
  const MATH_WORDS = new Set([
    'sin','cos','tan','cot','sec','csc','log','ln','lg','exp','min','max','arg',
    'sup','inf','det','dim','lim','mod','gcd','lcm','var','std','relu','sig','sgn','softmax',
  ]);
  return words.filter((w) => !MATH_WORDS.has(w.toLowerCase())).length;
}

async function analyzeAll(fixture: string, maxPages: number): Promise<PageAnalysis[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(resolve(here, `../../../fixtures/${fixture}`)));
  const doc = await pdfjs
    .getDocument({ data, standardFontDataUrl: STANDARD_FONTS, disableFontFace: true, useSystemFonts: false })
    .promise;
  const out: PageAnalysis[] = [];
  const pageCount = Math.min(maxPages, doc.numPages);
  for (let p = 1; p <= pageCount; p += 1) {
    const page: any = await doc.getPage(p);
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
        id: `p${p - 1}-i${n}`, str: raw.str, bbox: toBBox(ri, viewport.transform, SCALE),
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
    out.push(analyzePage({
      pageIndex: p - 1, width: viewport.width, height: viewport.height, items,
      options: { rawPaths, rawImages, isInsideFigure: (bbox) => isEnclosedByGraphics(bbox, figurePaths, 3 * SCALE) },
    }));
  }
  return out;
}

/** 一个仍可译的块「明显像公式却没被标记」= 泄漏。用于回归守护。 */
function isLeak(b: Block): boolean {
  if (!b.isBodyText || !b.translatable || b.formula || b.nonTranslatableReason) return false;
  // 与 formulas.ts 的判据对齐：编号公式需强运算符密度 ≥0.1；无编号需 ≥0.4 且零长单词。
  const numbered = EQ_NUMBER.test(b.text) && strongDensity(b.text) >= 0.1;
  const unnumbered = strongDensity(b.text) >= 0.4 && longWords(b.text) === 0;
  return numbered || unnumbered;
}

describe('公式泄漏回归守护', () => {
  it('三条基线都不应出现「可译却明显是公式」的块', async () => {
    const targets: Array<[string, number]> = [
      ['two-column-sample.pdf', 12],
      ['single-column-sample.pdf', 12],
      ['acl-sample.pdf', 12],
    ];
    const leaks: string[] = [];
    for (const [fixture, max] of targets) {
      const analyses = await analyzeAll(fixture, max);
      for (const a of analyses) {
        for (const b of a.blocks) {
          if (isLeak(b)) leaks.push(`  ${fixture} p${a.pageIndex + 1}: ${b.text.slice(0, 80)}`);
        }
      }
    }
    expect(leaks, leaks.join('\n')).toEqual([]);
  }, 180000);
});
