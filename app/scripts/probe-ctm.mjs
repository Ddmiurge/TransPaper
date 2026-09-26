/**
 * 验证「追踪 CTM 栈」能否把矢量路径的包围盒还原到视口坐标。
 *
 * 背景：pdf.js 的 constructPath 参数里带了路径包围盒（args[2]），
 * 但它是在**当时生效的 CTM 空间**下的，而不是页面坐标。真实论文里
 * 几乎每页都有 transform 指令，所以直接拿这个包围盒会得到明显超出页面的数值。
 *
 * 若本脚本能证明「累积 transform + save/restore 栈」可以还原出落在页面内的包围盒，
 * 就可以用它来做图形区域检测 —— 比像素采样稳得多。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const OPS = pdfjs.OPS;

const doc = await pdfjs.getDocument({
  data: new Uint8Array(readFileSync('fixtures/two-column-sample.pdf')),
  standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
  disableFontFace: true,
  useSystemFonts: false,
}).promise;

/** 矩阵乘法（行向量约定：点在左，矩阵在右） */
function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/** 用矩阵变换一个包围盒，返回轴对齐的包围盒 */
function transformBox(m, x0, y0, x1, y1) {
  const pts = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const nameOfOp = new Map(Object.entries(OPS).map(([k, v]) => [v, k]));
const FORM_BEGIN = OPS.paintFormXObjectBegin;
const FORM_END = OPS.paintFormXObjectEnd;

for (let p = 1; p <= 6; p += 1) {
  const page = await doc.getPage(p);
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  const vt = vp.transform;

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const boxes = [];
  let formCount = 0;

  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];

    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      if (stack.length) ctm = stack.pop();
    } else if (fn === OPS.transform) {
      ctm = mul(ctm, args);
    } else if (fn === FORM_BEGIN) {
      formCount += 1;
      stack.push(ctm);
      if (Array.isArray(args[0])) ctm = mul(ctm, args[0]);
    } else if (fn === FORM_END) {
      if (stack.length) ctm = stack.pop();
    } else if (fn === OPS.constructPath) {
      const mm = args[2];
      if (!mm) continue;
      const raw = [mm[0], mm[1], mm[2], mm[3]].map(Number);
      if (raw.some((v) => !Number.isFinite(v))) continue;
      boxes.push(transformBox(mul(ctm, vt), raw[0], raw[1], raw[2], raw[3]));
    }
  }

  let desc = '无';
  if (boxes.length) {
    const xs = boxes.flatMap((b) => [b[0], b[2]]);
    const ys = boxes.flatMap((b) => [b[1], b[3]]);
    const inPage =
      xs.every((v) => v >= -4 && v <= vp.width + 4) && ys.every((v) => v >= -4 && v <= vp.height + 4);
    desc =
      `x ${Math.min(...xs).toFixed(0)}→${Math.max(...xs).toFixed(0)} | ` +
      `y ${Math.min(...ys).toFixed(0)}→${Math.max(...ys).toFixed(0)} | ` +
      `落在页内: ${inPage ? '✅ 是' : '❌ 否'}`;
  }
  const names = new Set();
  for (let i = 0; i < ops.fnArray.length; i += 1) names.add(nameOfOp.get(ops.fnArray[i]));
  console.log(`第 ${p} 页: 路径 ${boxes.length} 个 | formXObject ${formCount} 处`);
  console.log(`   ${desc}`);
  if (p === 2 || p === 4) {
    console.log(`   算子种类: ${[...names].join(', ')}`);
  }
}
