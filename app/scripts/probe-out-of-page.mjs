/** 探针：统计各 fixture 路径包围盒的「页外比例」分布，为 sanity check 定阈值 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FONTS = `${resolve(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts')}/`;
const FIXTURES = [
  'two-column-sample.pdf',
  'single-column-sample.pdf',
  'acl-sample.pdf',
  'eyes-on-me.pdf',
];

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const mod = await import('../src/pdf/operatorPaths.ts');

for (const fx of FIXTURES) {
  const data = new Uint8Array(readFileSync(resolve(process.cwd(), 'fixtures', fx)));
  const doc = await pdfjs.getDocument({
    data, standardFontDataUrl: FONTS, disableFontFace: true, useSystemFonts: false,
  }).promise;
  const worst = [];
  let total = 0;
  const pages = Math.min(doc.numPages, 12);
  for (let p = 1; p <= pages; p += 1) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1.5 });
    const ops = await page.getOperatorList();
    const { paths } = mod.geometryBoxesFromOperators(ops, vp.transform, pdfjs.OPS);
    total += paths.length;
    for (const b of paths) {
      const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y);
      const x1 = Math.min(vp.width, b.x + b.width), y1 = Math.min(vp.height, b.y + b.height);
      if (x1 <= x0 || y1 <= y0) { worst.push({ p, ratio: 1 }); continue; }
      const area = b.width * b.height;
      const inside = (x1 - x0) * (y1 - y0);
      const out = 1 - inside / area;
      // 只记录单方向溢出比例（面积比会被窄条路径放大）
      const overX = Math.max(-b.x, b.x + b.width - vp.width, 0) / Math.max(1, b.width);
      const overY = Math.max(-b.y, b.y + b.height - vp.height, 0) / Math.max(1, b.height);
      worst.push({ p, ratio: Math.max(overX, overY), areaOut: out });
    }
  }
  worst.sort((a, b) => b.ratio - a.ratio);
  const partial = worst.filter((w) => w.ratio > 0.001 && w.ratio < 0.999);
  console.log(`${fx}: ${pages}页 ${total}条路径`);
  console.log(`   完全页外: ${worst.filter((w) => w.ratio >= 0.999).length} 条`);
  console.log(`   部分页外 top8: ` + partial.slice(0, 8).map((w) => `p${w.p}:${(w.ratio * 100).toFixed(0)}%`).join(' '));
}
