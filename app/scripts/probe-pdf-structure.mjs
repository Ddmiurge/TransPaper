/**
 * 探测脚本：看看 PDF 里有哪些可用于「区分正文与图形」的信号。
 *
 * 用 pdf.js 的 operator list 统计内容流的操作类型分布，
 * 并输出每页的「行结构」特征，用于找出正文行与图内标签的判别依据。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, '../fixtures/two-column-sample.pdf');
const FONTS = `${resolve(here, '../node_modules/pdfjs-dist/standard_fonts')}/`;

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({
  data: new Uint8Array(readFileSync(FIXTURE)),
  standardFontDataUrl: FONTS,
  disableFontFace: true,
  useSystemFonts: false,
}).promise;

const OPS = pdfjs.OPS;
const opName = {};
for (const [k, v] of Object.entries(OPS)) if (typeof v === 'number') opName[v] = k;

const INTERESTING = [
  'paintImageXObject',
  'paintInlineImageXObject',
  'paintImageMaskXObject',
  'paintFormXObjectBegin',
  'paintFormXObjectEnd',
  'constructPath',
  'stroke',
  'fill',
  'eoFill',
  'rectangle',
  'moveTo',
  'lineTo',
  'curveTo',
  'showText',
  'showSpacedText',
  'setFont',
];

for (const pageNo of [3, 4]) {
  const page = await doc.getPage(pageNo);
  const opList = await page.getOperatorList();

  const counts = new Map();
  for (const fn of opList.fnArray) counts.set(fn, (counts.get(fn) ?? 0) + 1);

  console.log(`\n========== 第 ${pageNo} 页 ==========`);
  console.log(`操作总数 ${opList.fnArray.length}`);
  for (const name of INTERESTING) {
    const code = OPS[name];
    if (code === undefined) continue;
    const n = counts.get(code) ?? 0;
    if (n > 0) console.log(`  ${name.padEnd(26)} ${n}`);
  }

  // 位图对象：记录其尺寸，用于判断图区大小
  const imageArgs = [];
  opList.fnArray.forEach((fn, i) => {
    if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      imageArgs.push(opList.argsArray[i][0]);
    }
  });
  if (imageArgs.length > 0) {
    console.log(`  → 位图对象 ${imageArgs.length} 个: ${imageArgs.slice(0, 6).map((a) => String(a).slice(0, 24)).join(', ')}`);
  }

  // ── 行结构特征 ──
  const viewport = page.getViewport({ scale: 1.5 });
  const tc = await page.getTextContent();
  const items = [];
  for (const raw of tc.items) {
    if (typeof raw.str !== 'string' || !raw.str.trim()) continue;
    const tx = pdfjs.Util.transform(viewport.transform, raw.transform);
    const h = Math.hypot(tx[2], tx[3]);
    items.push({ str: raw.str, x: tx[4], y: tx[5], w: raw.width * 1.5, h });
  }
  items.sort((a, b) => a.y - b.y || a.x - b.x);

  // 按基线聚行
  const lines = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.y - last.y) < 4) {
      last.items.push(it);
      last.y = (last.y * (last.items.length - 1) + it.y) / last.items.length;
    } else {
      lines.push({ y: it.y, items: [it] });
    }
  }

  console.log(`  行数 ${lines.length}`);
  console.log('  前 14 行的结构（x 起点 / 右端 / 宽度 / 字号 / 文本）:');
  for (const line of lines.slice(0, 14)) {
    const xs = line.items.map((i) => i.x);
    const rights = line.items.map((i) => i.x + i.w);
    const left = Math.min(...xs);
    const right = Math.max(...rights);
    const font = Math.max(...line.items.map((i) => i.h));
    // 一行内 x 的「断点」数量：正文通常 0–1，图内并排标签很多
    let breaks = 0;
    const sorted = [...line.items].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w) > font * 1.2) breaks += 1;
    }
    const text = line.items.map((i) => i.str).join(' ').slice(0, 46);
    console.log(
      `    x=${left.toFixed(0).padStart(4)} → ${right.toFixed(0).padStart(4)} w=${(right - left).toFixed(0).padStart(4)} ` +
        `fs=${font.toFixed(1).padStart(4)} 断点=${breaks} 片段=${line.items.length} :: ${text}`
    );
  }
}
