/**
 * 2D 仿射变换矩阵。
 *
 * 约定与 pdf.js 的 Util.transform 完全一致：
 *   x' = a·x + c·y + e
 *   y' = b·x + d·y + f
 * 存储为 [a, b, c, d, e, f]。
 *
 * 这里自己实现而不调用 pdfjsLib.Util.transform，是为了让几何层不依赖 pdf.js，
 * 从而可以在 Node 里无浏览器地跑单元测试与离线校验（对应 docs/01 的「领域层零 IO」）。
 */
export type Matrix = [number, number, number, number, number, number];

/** 矩阵复合，等价于 pdf.js 的 Util.transform(m1, m2) */
export function compose(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}
