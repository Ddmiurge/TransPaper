import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { analyzePage } from '../pipeline';
import { buildPageFlow } from '../pageFlow';
import { figurePathBoxes, isEnclosedByGraphics } from '../figureRegions';
import { geometryBoxesFromOperators } from '../../pdf/operatorPaths';
import { collectFontTraits } from '../../pdf/fontTraits';
import { baselineOf, fontSizeOf, isRotatedTransform, toBBox } from '../geometry';
import type { PageAnalysis, RawTextItem, TextItem } from '../../types';

const here = dirname(fileURLToPath(import.meta.url));
const STANDARD_FONTS = `${resolve(here, '../../../node_modules/pdfjs-dist/standard_fonts')}/`;
const SCALE = 1.5;

/** 与 realPdf.test.ts 走完全相同的提取路径 */
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

describe('文字表格识别 · 真实 PDF', () => {
  it('ACL 样本检出全部文字表格，且表格文字不再进入翻译', async () => {
    const analyses = await analyzeAll('acl-sample.pdf', 17);
    const total = analyses.reduce((s, a) => s + a.tableRegions.length, 0);
    expect(total).toBeGreaterThanOrEqual(8);

    // p6 主结果表（探针实测 11 行）
    const p6 = analyses[5];
    expect(p6.tableRegions.length).toBeGreaterThanOrEqual(1);
    const mainTable = p6.tableRegions.reduce((a, b) => (b.lineIds.length > a.lineIds.length ? b : a));
    expect(mainTable.lineIds.length).toBeGreaterThanOrEqual(11);
    const tableText = mainTable.lineIds
      .map((lid) => p6.lines.find((l) => l.id === lid)?.text ?? '')
      .join('\n');
    expect(tableText).toContain('No Defense');

    // 关键性质：表格区域与任何「可译正文块」不相交 —— 表格不会再被翻译
    for (const a of analyses) {
      for (const b of a.blocks) {
        if (!(b.isBodyText && b.translatable)) continue;
        for (const t of a.tableRegions) {
          const w = Math.min(b.bbox.x + b.bbox.width, t.bbox.x + t.bbox.width) - Math.max(b.bbox.x, t.bbox.x);
          const h = Math.min(b.bbox.y + b.bbox.height, t.bbox.y + t.bbox.height) - Math.max(b.bbox.y, t.bbox.y);
          const overlap = w > 0 && h > 0 ? (w * h) / (b.bbox.width * b.bbox.height) : 0;
          expect(overlap, `p${a.pageIndex + 1} 可译块被卷进表格区域：${b.text.slice(0, 50)}`).toBeLessThan(0.5);
        }
      }
    }
  }, 180000);

  it('ACL p6：表格在文档流中成为完整切片（而不是逐行碎条）', async () => {
    const analyses = await analyzeAll('acl-sample.pdf', 6);
    const p6 = analyses[5];
    const region = p6.tableRegions.reduce((a, b) => (b.lineIds.length > a.lineIds.length ? b : a));
    const figurePaths = p6.tableRegions.map((t) => t.bbox);
    const flow = buildPageFlow(p6, new Map(), { hasContent: () => true, figurePaths, figureRegions: p6.figureRegions });
    // 与表格纵向相交且覆盖其大部的切片
    const covering = flow.nodes.filter(
      (n): n is Extract<typeof n, { kind: 'slice' }> =>
        n.kind === 'slice' &&
        n.source.y < region.bbox.y + region.bbox.height &&
        n.source.y + n.source.height > region.bbox.y
    );
    const coveredHeight = covering.reduce((s, n) => {
      const y0 = Math.max(n.source.y, region.bbox.y);
      const y1 = Math.min(n.source.y + n.source.height, region.bbox.y + region.bbox.height);
      return s + Math.max(0, y1 - y0);
    }, 0);
    expect(coveredHeight / region.bbox.height).toBeGreaterThan(0.8);
    // 单个切片包住绝大部分表格（不再一行一条）
    const best = covering.reduce((m, n) => Math.max(m, Math.min(n.source.y + n.source.height, region.bbox.y + region.bbox.height) - Math.max(n.source.y, region.bbox.y)), 0);
    expect(best / region.bbox.height).toBeGreaterThan(0.8);
  }, 120000);

  it('ResNet：图内标签产生的区域无害——没有任何正文块被改标为表格', async () => {
    const analyses = await analyzeAll('two-column-sample.pdf', 6);
    const marked = analyses.flatMap((a) => a.blocks).filter((b) => b.figureReason === 'table-region');
    expect(marked).toHaveLength(0);
    // 正文流不受影响：可译块数量与表格区域无关地保持稳定
    const translatable = analyses.reduce(
      (s, a) => s + a.blocks.filter((b) => b.isBodyText && b.translatable).length,
      0
    );
    expect(translatable).toBeGreaterThan(0);
  }, 120000);

  it('单栏样本：误报段落保持可译，无正文块被改标', async () => {
    const analyses = await analyzeAll('single-column-sample.pdf', 12);
    const marked = analyses.flatMap((a) => a.blocks).filter((b) => b.figureReason === 'table-region');
    expect(marked).toHaveLength(0);
    // 探针阶段的真实误报（p6「As shown in Table 2, monolingual probes…」正文段落）
    // 必须仍然是可译正文 —— 这是长词密度闸的直接回归断言
    const paragraph = analyses[5].blocks.find((b) => b.text.includes('monolingual probes'));
    expect(paragraph).toBeDefined();
    expect(paragraph!.isBodyText).toBe(true);
    expect(paragraph!.translatable).toBe(true);
  }, 120000);
});
