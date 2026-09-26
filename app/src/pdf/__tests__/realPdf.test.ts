import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { analyzePage } from '../../domain/pipeline';
import { figurePathBoxes, isEnclosedByGraphics } from '../../domain/figureRegions';
import { selfCheck, type SelfCheckReport } from '../../domain/selfCheck';
import { baselineOf, fontSizeOf, isRotatedTransform, toBBox } from '../../domain/geometry';
import { buildPageFlow } from '../../domain/pageFlow';
import { geometryBoxesFromOperators } from '../operatorPaths';
import { collectFontTraits } from '../fontTraits';
import type { PageAnalysis, RawTextItem, TextItem } from '../../types';

const here = dirname(fileURLToPath(import.meta.url));
// 用环境变量可切换样本：FIXTURE=single-column-sample.pdf npx vitest run src/pdf
const FIXTURE = resolve(
  here,
  `../../../fixtures/${process.env.FIXTURE ?? 'two-column-sample.pdf'}`
);
// pdf.js 要求该路径必须以斜杠结尾，path.resolve 会去掉它，所以手动补回
const STANDARD_FONTS = `${resolve(here, '../../../node_modules/pdfjs-dist/standard_fonts')}/`;
const SCALE = 1.5;
// 校验页数上限。用环境变量可临时扩大，便于检查参考文献页、附录等靠后的版式：
//   MAX_PAGES=12 npx vitest run src/pdf
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 6);

async function extractPage(
  page: any,
  pageIndex: number
): Promise<{ items: TextItem[]; width: number; height: number }> {
  const viewport = page.getViewport({ scale: SCALE });
  const textContent = await page.getTextContent();
  const styles: Record<string, { fontFamily?: string }> = textContent.styles ?? {};

  // 与生产代码走同一条路：先求值算子列表，再从 commonObjs 取真实 PostScript 字体名
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
      id: `p${pageIndex}-i${n}`,
      str: raw.str,
      bbox: toBBox(ri, viewport.transform, SCALE),
      baselineY: baselineOf(ri, viewport.transform),
      fontSize: fontSizeOf(ri, viewport.transform, SCALE),
      fontName: ri.fontName,
      fontFamily: styles[ri.fontName]?.fontFamily ?? '',
      bold: traits.get(ri.fontName)?.bold ?? false,
      italic: traits.get(ri.fontName)?.italic ?? false,
      rotated: isRotatedTransform(ri.transform),
      columnIndex: -1,
    });
    n += 1;
  }

  return { items, width: viewport.width, height: viewport.height };
}

describe('真实双栏 PDF 的端到端校验', () => {
  it('提取文本项、分栏、重建段落，并输出自检报告', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(readFileSync(FIXTURE));
    const doc = await pdfjs.getDocument({
      data,
      standardFontDataUrl: STANDARD_FONTS,
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;

    const pageCount = Math.min(MAX_PAGES, doc.numPages);
    console.log(`\n文档共 ${doc.numPages} 页，校验前 ${pageCount} 页，scale=${SCALE}`);

    const results: Array<{ analysis: PageAnalysis; report: SelfCheckReport }> = [];

    for (let p = 1; p <= pageCount; p += 1) {
      const page = await doc.getPage(p);
      const extracted = await extractPage(page, p - 1);

      // 图形区域：与浏览器侧走完全相同的代码路径，因此这里的结论对生产有效
      const ops = await page.getOperatorList();
      const viewport = page.getViewport({ scale: SCALE });
      const geometry = geometryBoxesFromOperators(ops, viewport.transform, pdfjs.OPS as any);
      const rawPaths = geometry.paths;
      // 位图（嵌入图片）放置框：ACL 等排版的图表是整张图，矢量路径为 0
      const rawImages = geometry.images;
      // 位图框并入切片几何（与浏览器侧 PageFlowBlock 保持一致）——
      // 否则位图图表被识别为区域却不参与空隙切图，整张图丢失
      const figurePaths = rawPaths.length > 0
        ? figurePathBoxes(rawPaths).concat(rawImages)
        : rawImages;

      console.log(`\n── 第 ${p} 页 ──`);

      const analysis = analyzePage({
        pageIndex: p - 1,
        width: extracted.width,
        height: extracted.height,
        items: extracted.items,
        options: {
          rawPaths,
          rawImages,
          isInsideFigure: (bbox) => isEnclosedByGraphics(bbox, figurePaths, 3 * SCALE),
        },
      });
      const report = selfCheck(analysis);
      results.push({ analysis, report });

      // 跨栏的图形区域：交给文档流作为整体裁切（依赖检测出的栏缝位置）
      const figureRegions = analysis.figureRegions;

      // 图形覆盖自检：图形路径有没有被正文块「挖掉」的像素
      // 文字表格矩形并入切片几何（I17）：表格没有矢量路径，
      // 不并入则空隙切图不发生 —— 与位图框（I13）同一类坑
      const sliceGeometry = figurePaths.concat(analysis.tableRegions.map((t) => t.bbox));
      const flow = buildPageFlow(analysis, new Map(), {
        hasContent: () => true,
        figurePaths: sliceGeometry,
        figureRegions,
      });
      const coverage = flow.stats;
      // 口径取「isBodyText && translatable」—— 这才是真正会被送去翻译的集合。
      // 只看 translatable 会把图内文字也算进来，那个数字没有决策价值。
      const translatable = analysis.blocks.filter((b) => b.isBodyText && b.translatable).length;
      // 公式块一目了然：判定错了（或漏了）立刻能在报告里看到文本内容
      const formulas = analysis.blocks.filter((b) => b.formula);
      if (formulas.length > 0) {
        console.log(` 行间公式 ${formulas.length} 个:`);
        for (const f of formulas) console.log(`   · ${f.text.slice(0, 76)}`);
      }
      // 行内上下标抽样：正文里被识别为 sub/sup 的片段
      const scripted = analysis.blocks
        .filter((b) => b.isBodyText)
        .flatMap((b) =>
          b.spans
            .filter((s) => s.script)
            .map((s) => ({ chunk: b.text.slice(s.start, s.end), script: s.script }))
        );
      if (scripted.length > 0) {
        console.log(
          ` 上下标片段 ${scripted.length} 个: ` +
            scripted.slice(0, 8).map((x) => `${x.chunk}(${x.script})`).join(' ')
        );
      }
      // DUMP_PAGE=N：打印该页每个块的完整文本与判定 —— 排查漏判/误判用
      if (Number(process.env.DUMP_PAGE ?? 0) === p) {
        for (const b of analysis.blocks) {
          console.log(
            ` [${b.isBodyText ? (b.formula ? '公式' : b.translatable ? '正文' : `不译:${b.nonTranslatableReason}`) : `图像:${b.figureReason}`}]` +
              ` x=${b.bbox.x.toFixed(0)}→${(b.bbox.x + b.bbox.width).toFixed(0)}` +
              ` y=${b.bbox.y.toFixed(0)}→${(b.bbox.y + b.bbox.height).toFixed(0)}` +
              ` 行${b.lineIds.length} 字${b.fontScale.toFixed(2)} :: ${b.text.slice(0, 160)}`
          );
        }
      }

      const byReason = new Map<string, number>();
      for (const b of analysis.blocks) {
        if (b.nonTranslatableReason) {
          byReason.set(b.nonTranslatableReason, (byReason.get(b.nonTranslatableReason) ?? 0) + 1);
        }
      }
      console.log(
        ` 可译段 ${translatable}/${analysis.bodyBlockCount}（正文流内）` +
          (byReason.size > 0
            ? ` | 不翻译: ${[...byReason].map(([k, v]) => `${k}×${v}`).join(' ')}`
            : '') +
          ` | 文献区间 ${analysis.referencesActive ? '是' : '否'}`
      );

      console.log(
        ` 图形覆盖: 路径 ${figurePaths.length} 条，未被切片完整覆盖 ${coverage.uncoveredGraphicCount} 条 ` +
          `| 省掉的留白 ${coverage.droppedGapHeight.toFixed(0)}px | 切图高度 ${coverage.coveredHeight.toFixed(0)}px`
      );
      console.log(
        ` 被切成多片的图形区域: ${coverage.splitFigureCount} 个` +
          (coverage.splitFigureCount > 0 ? '  ← 图被从中间劈开、夹了译文，读起来就是「图断了」' : '')
      );
      console.log(
        ` 正文重复切图: ${coverage.duplicatedBlockCount} 个块 / ${coverage.duplicatedTextArea.toFixed(0)}px²` +
          (coverage.duplicatedBlockCount > 0 ? '  ← 这些正文会同时以文本和图像出现两次' : '')
      );
      if (coverage.duplicatedBlockCount > 0) {
        const slices = flow.nodes.filter((n: any) => n.kind === 'slice');
        for (const b of analysis.blocks.filter((x) => x.isBodyText)) {
          let overlap = 0;
          for (const sl of slices as any[]) {
            const w =
              Math.min(b.bbox.x + b.bbox.width, sl.source.x + sl.source.width) -
              Math.max(b.bbox.x, sl.source.x);
            const h =
              Math.min(b.bbox.y + b.bbox.height, sl.source.y + sl.source.height) -
              Math.max(b.bbox.y, sl.source.y);
            if (w > 0 && h > 0) overlap += w * h;
          }
          const area = b.bbox.width * b.bbox.height;
          if (area > 0 && overlap / area > 0.05) {
            console.log(
              `   ⚠ 重复 [×${b.fontScale.toFixed(2)}] x=${b.bbox.x.toFixed(0)}→${(b.bbox.x + b.bbox.width).toFixed(0)} ` +
                `y=${b.bbox.y.toFixed(0)}→${(b.bbox.y + b.bbox.height).toFixed(0)} :: ${b.text.slice(0, 42)}`
            );
          }
        }
      }

      // ── 图形路径坐标的交叉验证 ──
      //
      // 基准是「图内小字」：图的标签字号显著小于正文（实测 0.33–0.79 倍），
      // 且必然落在图形路径的包围范围内。图内文字的坐标来自 pdf.js 的文本变换，
      // 与路径提取是两条独立的代码路径，前者已在多轮迭代中被反复验证可靠，
      // 所以拿它当基准能检出路径坐标的系统性偏移。
      //
      // 这个判据抓到过一个代价很大的 bug：CTM 累乘写成了右乘，
      // 导致第 1/6 页的路径整体偏移（覆盖率 0%），修好后第 1 页回到 82%。
      //
      // 关键细节：必须**排除行内的上下标**。它们同样远小于正文，但属于正文的一部分，
      // 而且所在位置本来就没有图形路径 —— 不排除的话，公式多的页面（第 3 页）
      // 会被这 14 个上下标把覆盖率压到 0%，造成假警报。
      const bodyFont = report.medianFontSize;
      const isInlineScript = (small: TextItem) =>
        extracted.items.some((other) => {
          if (other === small || other.fontSize < bodyFont * 0.85) return false;
          // 上下标与其所属的正文项基线接近、水平紧邻
          if (Math.abs(other.baselineY - small.baselineY) > bodyFont * 1.2) return false;
          const gap =
            Math.max(other.bbox.x, small.bbox.x) -
            Math.min(other.bbox.x + other.bbox.width, small.bbox.x + small.bbox.width);
          return gap < bodyFont * 2;
        });

      const figureLabels = extracted.items.filter(
        (it) => bodyFont > 0 && it.fontSize < bodyFont * 0.85 && !isInlineScript(it)
      );
      const insideOf = (it: TextItem, box: { x: number; y: number; width: number; height: number }) => {
        const cx = it.bbox.x + it.bbox.width / 2;
        const cy = it.bbox.y + it.bbox.height / 2;
        return cx >= box.x && cx <= box.x + box.width && cy >= box.y && cy <= box.y + box.height;
      };
      const hit = figureLabels.filter((it) => rawPaths.some((box) => insideOf(it, box))).length;
      const coverageRatio = figureLabels.length > 0 ? hit / figureLabels.length : 1;
      console.log(
        ` 路径坐标吻合度: 图内标签 ${figureLabels.length} 项，落在路径框内 ${hit} 项 ` +
          `(${(coverageRatio * 100).toFixed(0)}%)`
      );

      if (rawPaths.length > 0) {
        const xs = rawPaths.flatMap((b) => [b.x, b.x + b.width]);
        const ys = rawPaths.flatMap((b) => [b.y, b.y + b.height]);
        console.log(
          ` 路径整体范围: x ${Math.min(...xs).toFixed(0)}→${Math.max(...xs).toFixed(0)} | ` +
            `y ${Math.min(...ys).toFixed(0)}→${Math.max(...ys).toFixed(0)}`
        );
      }

      // ── 旋转文字不得泄漏进文本流 ──
      //
      // 实测第 1 页有 3 项旋转文字：图 1 的纵轴标签 `training error (%)` / `test error (%)`
      // 与 arXiv 竖排侧标 `arXiv:1512.03385v1 [cs.CV] 10 Dec 2015`。
      // 侧标曾经与正文粘成一句：
      //   `arXiv:1512.03385v1 [cs.CV] 10 Dec 2015Deep convolutional neural networks [22, 21]`
      // 而该块字号是正文的 1.5 倍，于是被判为二级标题 —— 侧标就这样成了正文里的大字标题，
      // 顺便把紧跟的正文也一起吞了。
      const rotatedSnippets = extracted.items
        .filter((it) => it.rotated)
        .map((it) => it.str.trim())
        .filter((s) => s.length >= 6);
      if (rotatedSnippets.length > 0) {
        const leaked = rotatedSnippets.filter((snippet) =>
          // 只看正文块：图像块（切片）里出现同样的文字是正常的 ——
          // 图表里常有同一标签的旋转/水平两份副本，图像块的像素来自原 PDF，
          // 不存在「泄漏进文本流」的问题（实测 2608.02657 第 30 页误报过）
          analysis.blocks.some((block) => block.isBodyText && block.text.includes(snippet))
        );
        console.log(
          ` 旋转文字 ${rotatedSnippets.length} 项，泄漏进文本流 ${leaked.length} 项` +
            (leaked.length > 0 ? ` → ${leaked.map((s) => s.slice(0, 24)).join(' / ')}` : '')
        );
        if (!process.env.SOFT_LEAK) expect(leaked).toEqual([]);
      }

      // 需要排查「图表有没有被切碎 / 内容有没有漏出」时：
      //   FLOW_DUMP=2 npx vitest run src/pdf
      if (process.env.FLOW_DUMP && Number(process.env.FLOW_DUMP) === p) {
        const flow = buildPageFlow(analysis, new Map(), {
          hasContent: () => true,
          figurePaths: figurePaths.concat(analysis.tableRegions.map((t) => t.bbox)),
          figureRegions,
        });
        console.log(` 文档流节点（${flow.nodes.length} 个，内容宽 ${flow.stats.contentWidth}）：`);
        for (const node of flow.nodes) {
          if (node.kind === 'slice') {
            const s2 = node.source;
            console.log(
              `   [切片] x=${s2.x.toFixed(0)}→${(s2.x + s2.width).toFixed(0)} ` +
                `y=${s2.y.toFixed(0)}→${(s2.y + s2.height).toFixed(0)} (h=${s2.height.toFixed(0)})`
            );
          } else {
            const t = node.source.length > 40 ? `${node.source.slice(0, 40)}…` : node.source;
            console.log(`   [文本] :: ${t}`);
          }
        }
      }

      console.log(`矢量路径 ${rawPaths.length} 条 → 判定为图形的 ${figurePaths.length} 条`);
      console.log(
        ` 图形区域 ${figureRegions.length} 个: ` +
          figureRegions
            .map((r) => `x${r.x.toFixed(0)}→${(r.x + r.width).toFixed(0)} y${r.y.toFixed(0)}→${(r.y + r.height).toFixed(0)}`)
            .join(' | ')
      );
      console.log(
        `viewport ${extracted.width.toFixed(0)}×${extracted.height.toFixed(0)} | ` +
          `文本项 ${report.itemCount} | 行 ${report.lineCount} | 段 ${report.blockCount} | 栏 ${report.columnCount}`
      );
      console.log(
        `栏缝 x: ${analysis.columnSplits.map((s) => s.toFixed(0)).join(', ') || '未检出'} | ` +
          `每栏项数 ${report.itemsPerColumn.join(' / ')}`
      );
      console.log(
        `字号 ${report.medianFontSize} | 行高 ${report.medianLineHeight} | ` +
          `跨栏块 ${report.spanningBlocks} | 越栏块 ${report.outOfColumnBlocks} | ` +
          `行内重叠 ${report.lineOverlapCount}`
      );
      console.log(
        `间隙比中位 ${report.medianGapRatio} | 拥挤块 ${report.tightBlocks} | ` +
          `顺序单调 ${report.readingOrderMonotonic ? '是' : '否'}`
      );

      console.log(' 前 4 段（按阅读顺序）:');
      for (const block of analysis.blocks.slice(0, 4)) {
        const text = block.text.length > 62 ? `${block.text.slice(0, 62)}…` : block.text;
        console.log(
          `  [栏${block.columnIndex} #${block.readOrder}] x=${block.bbox.x.toFixed(0)} ` +
            `y=${block.bbox.y.toFixed(0)} w=${block.bbox.width.toFixed(0)} :: ${text}`
        );
      }

      // 正文判定的可观测性
      console.log(
        ` 正文字号 ${analysis.bodyFontSize} | 正文段 ${analysis.bodyBlockCount}/${analysis.blocks.length}`
      );
      console.log(' 全部段落指标（判定 / 字号倍率 / 宽度比 / 断点每行）:');
      for (const b of analysis.blocks) {
        const flag = b.isBodyText ? '正文' : `图像:${b.figureReason}`;
        const t = b.text.length > 34 ? `${b.text.slice(0, 34)}…` : b.text;
        console.log(
          `   [${flag}] ×${b.fontScale.toFixed(2)} 宽比${b.widthRatio.toFixed(2)} ` +
            `断点/行${b.gapsPerLine.toFixed(1)} h${b.headingLevel} ` +
            `行${b.lineIds.length} x=${b.bbox.x.toFixed(0)}→${(b.bbox.x + b.bbox.width).toFixed(0)} ` +
            `y=${b.bbox.y.toFixed(0)}→${(b.bbox.y + b.bbox.height).toFixed(0)} :: ${t}`
        );
        if (b.figureReason === 'graphics-region') {
          const hit = figurePaths.filter((box) => isEnclosedByGraphics(b.bbox, [box], 2));
          console.log(
            `      ↳ 块框 x=${b.bbox.x.toFixed(0)}→${(b.bbox.x + b.bbox.width).toFixed(0)} ` +
              `y=${b.bbox.y.toFixed(0)}→${(b.bbox.y + b.bbox.height).toFixed(0)}；` +
              `相交路径 ${hit.length} 条：` +
              hit
                .slice(0, 3)
                .map(
                  (h) =>
                    `[x${h.x.toFixed(0)}→${(h.x + h.width).toFixed(0)} y${h.y.toFixed(0)}→${(
                      h.y + h.height
                    ).toFixed(0)}]`
                )
                .join(' ')
          );
        }
      }
    }

    // ── 硬断言：任何一页都必须成立 ──
    for (const { report } of results) {
      // 阈值 10：图表占满的页（附录整页大图）文本项本来就少（实测单栏样本
      // 最少 47 项），只要不是 0/灾难性失败即可
      expect(report.itemCount).toBeGreaterThan(10);
      expect(report.blockCount).toBeGreaterThan(0);
      expect(report.outOfColumnBlocks, '越栏块必须为 0').toBe(0);
      expect(report.readingOrderMonotonic, '阅读顺序必须单调').toBe(true);
    }

    const totalLines = results.reduce((a, r) => a + r.report.lineCount, 0);
    const totalOverlap = results.reduce((a, r) => a + r.report.lineOverlapCount, 0);
    const twoColumnPages = results.filter((r) => r.report.columnCount === 2).length;

    console.log('\n── 汇总 ──');
    console.log(`行内重叠 ${totalOverlap} / ${totalLines} 行`);
    console.log(`检出双栏的页数 ${twoColumnPages} / ${results.length}`);
    console.log(
      `跨栏块总计 ${results.reduce((a, r) => a + r.report.spanningBlocks, 0)}（标题、作者行等，属正常）`
    );

    expect(totalOverlap / Math.max(1, totalLines), '行内重叠比例应 < 2%').toBeLessThan(0.02);
  }, 60000);
});
