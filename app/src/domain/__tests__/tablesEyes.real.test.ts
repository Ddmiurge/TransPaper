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
import type { BBox, Block, PageAnalysis, RawTextItem, TextItem } from '../../types';
import type { TableRegion } from '../tables';

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

/** 同上，但额外返回每页的原始矢量/位图几何（对齐 PageFlowBlock 的真实输入） */
async function analyzeAllWithGeometry(
  fixture: string,
  maxPages: number
): Promise<Array<{ analysis: PageAnalysis; figurePaths: BBox[] }>> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(resolve(here, `../../../fixtures/${fixture}`)));
  const doc = await pdfjs
    .getDocument({ data, standardFontDataUrl: STANDARD_FONTS, disableFontFace: true, useSystemFonts: false })
    .promise;
  const out: Array<{ analysis: PageAnalysis; figurePaths: BBox[] }> = [];
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
    out.push({
      analysis: analyzePage({
        pageIndex: p - 1, width: viewport.width, height: viewport.height, items,
        options: { rawPaths, rawImages, isInsideFigure: (bbox) => isEnclosedByGraphics(bbox, figurePaths, 3 * SCALE) },
      }),
      figurePaths,
    });
  }
  return out;
}

describe('Eyes-on-Me（真实 PDF）· 跨栏表格', () => {
  it('p8 Table 5：横跨双栏的表被识别为**一个**区域，左右两半不再分裂', async () => {
    const analyses = await analyzeAll('eyes-on-me.pdf', 8);
    const p8: PageAnalysis = analyses[7]!;

    // Table 5 的数据行左右两栏各 5 行、y 严格对齐（173/188/203/223/238）
    const full = p8.tableRegions.filter((r: TableRegion) => r.bbox.width > 500);
    expect(
      full.length,
      `期望恰好一个全宽表格区域，实际 ${p8.tableRegions.length} 个：` +
        JSON.stringify(p8.tableRegions.map((r: TableRegion) => ({ w: Math.round(r.bbox.width), y: Math.round(r.bbox.y) })))
    ).toBe(1);

    const region = full[0];
    // 必须覆盖中缝（x 从左栏一直伸到右栏末尾）
    expect(region.bbox.x).toBeLessThan(200);
    expect(region.bbox.x + region.bbox.width).toBeGreaterThan(700);
  }, 180000);

  it('p8 Table 5：表头行被纳入表格（不再被抽走当正文）', async () => {
    const analyses = await analyzeAll('eyes-on-me.pdf', 8);
    const p8: PageAnalysis = analyses[7]!;
    const region = p8.tableRegions.find((r: TableRegion) => r.bbox.width > 500)!;

    // 表头三行原本 0–1 个单元格间隙，永远进不了候选（I28 修复对象）
    const headerTexts = [
      'Optimization Positional Method',
      'Cost (mins.) Sensitivity (↓)',
      'Against SOTA Defenses (G-ASR ↑)',
    ];
    for (const want of headerTexts) {
      const block = p8.blocks.find((b: Block) => b.text.includes(want.slice(0, 20)));
      expect(block, `找不到表头块：${want}`).toBeDefined();
      expect(
        block!.figureReason,
        `表头「${want}」被误标为图内文字（应随表格整块切图）`
      ).toBe('table-region');
      expect(block!.translatable).toBe(false);
    }

    // 表头行确实进了区域
    const regionText = region.lineIds
      
      .map((lid: string) => p8.lines.find((l: { id: string; text: string }) => l.id === lid)?.text ?? '')
      .join(' ');
    expect(regionText).toContain('Optimization Positional');
    expect(regionText).toContain('Against SOTA Defenses');
  }, 180000);

  it('p8：Table 5 在文档流中是**一整块**切片（不是左右两块 + 表头缺位）', async () => {
    const analyses = await analyzeAllWithGeometry('eyes-on-me.pdf', 8);
    const p8: PageAnalysis = analyses[7]!.analysis;
    // 与 PageFlowBlock 真实渲染路径一致：figurePaths = 矢量/位图几何 + 表格区域
    const sliceGeometry = analyses[7]!.figurePaths.concat(p8.tableRegions.map((t: TableRegion) => t.bbox));
    const region = p8.tableRegions.find((r: TableRegion) => r.bbox.width > 500)!;
    const flow = buildPageFlow(p8, new Map(), {
      hasContent: () => true,
      figurePaths: sliceGeometry,
      figureRegions: p8.figureRegions,
      tableRegions: p8.tableRegions.map((t: TableRegion) => t.bbox),
    });
    const slices = flow.nodes.filter((n) => n.kind === 'slice');

    // 切片纵向覆盖表格的大部
    const covered = slices.reduce((sum, n) => {
      const y0 = Math.max(n.source.y, region.bbox.y);
      const y1 = Math.min(n.source.y + n.source.height, region.bbox.y + region.bbox.height);
      return sum + Math.max(0, y1 - y0);
    }, 0);
    expect(covered / region.bbox.height).toBeGreaterThan(0.9);

    // 关键回归：**存在一个切片**精确对应整张表 —— 左右两半不得分裂。
    //
    // 修复前：表格区域分裂成 w=302 / w=271 两块，切片也从中间劈开、
    // 表头还因漏判被抽走，切片与表头对不上。
    // 修复后：表格区域是全宽一块，切片精确等于它。
    //
    // 注意这里**不**断言「整页只有 1 个切片」：同页其它图形（下方 Figure）
    // 仍会各自切片，那是正常的。守的是「表格这一块不能再裂开」。
    const exact = slices.filter(
      (s) =>
        Math.abs(s.source.x - region.bbox.x) <= 2 &&
        Math.abs(s.source.y - region.bbox.y) <= 2 &&
        Math.abs(s.source.width - region.bbox.width) <= 4
    );
    expect(
      exact.length,
      `期望 1 个切片精确对应整张表，实际 ${exact.length} 个：` +
        JSON.stringify(slices.map((s) => ({ x: Math.round(s.source.x), y: Math.round(s.source.y), w: Math.round(s.source.width), h: Math.round(s.source.height) })))
    ).toBe(1);
    // 纵向也不得超出表格（不吞表格上下的正文）
    expect(exact[0]!.source.height).toBeLessThanOrEqual(region.bbox.height + 4);
  }, 180000);

  it('p8：表格题注仍可译（Table 6 说明段没有被表格区域吞掉）', async () => {
    const analyses = await analyzeAll('eyes-on-me.pdf', 8);
    const p8: PageAnalysis = analyses[7]!;
    const caption = p8.blocks.find((b: Block) => b.text.includes('Table 6. Ablations for attack factors'));
    expect(caption).toBeDefined();
    expect(caption!.isBodyText).toBe(true);
    expect(caption!.translatable).toBe(true);
  }, 180000);
});
