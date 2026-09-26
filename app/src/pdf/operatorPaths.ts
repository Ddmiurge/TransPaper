import type { BBox } from '../types';

/**
 * 从 pdf.js 的算子列表中提取矢量绘图路径的包围盒（视口坐标）。
 *
 * 这个模块**刻意不 import pdf.js** —— 算子枚举由调用方以参数传入。
 * 好处是它能在 Node 里被直接测试（只需把 getOperatorList() 的结果喂进来），
 * 而不必拉起 pdf.js 的浏览器构建（后者依赖 DOM）。
 *
 * ── 为什么需要追踪 CTM ──
 * pdf.js 的 `constructPath` 算子参数里带了路径包围盒（args[2]，Float32Array），
 * 但它是在**当时生效的变换矩阵（CTM）空间**下的，不是页面坐标。
 * 真实论文里几乎每页都有 `transform` 指令（实测 ResNet 论文：第 4 页 244 条），
 * 直接拿来用会得到明显超出页面的数值（第 4 页曾算出 y 到 885，而页高只有 792）。
 *
 * 所以这里自己维护一个矩阵栈：save 入栈、restore 出栈、transform 累乘，
 * formXObject 进入/退出整体压栈。
 *
 * ── 累乘方向（踩过一次，代价很大）──
 * PDF 的 `cm` 语义是 `CTM_new = M × CTM_old` —— 新矩阵**左乘**。
 * 这里最初写成了 `multiply(ctm, M)`（右乘），方向反了。
 * 反了之后**只有单一变换时看不出问题**（`I × M === M × I`），
 * 于是第 4、5 页（图形变换结构简单）看起来是对的，掩盖了 bug；
 * 而第 1、6 页有「平移叠缩放叠 form 矩阵」的多层嵌套，偏差立刻暴露：
 * 第 1 页图 1 的路径被算到 x≈339（左栏），而它实际在 x≈463 起的右栏。
 *
 * 判据是「图形路径应当覆盖图内文字」——图内文字用 pdf.js 的文本变换（已独立验证可靠），
 * 可作交叉基准。修正前吻合率：第 1 页 0%、第 6 页 0%。
 */

export interface OperatorListLike {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<any>;
}

/** pdf.js 中本模块用到的算子编号 */
export interface OperatorIds {
  save: number;
  restore: number;
  transform: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  constructPath: number;
  /** 以下为**位图**绘制算子（可选传入；不传则不提取位图框） */
  paintImageXObject?: number;
  paintImageXObjectRepeat?: number;
  paintInlineImageXObject?: number;
  paintImageMaskXObject?: number;
  paintJpegXObject?: number;
}

/** 矩阵乘法（与 pdf.js 的 Util.transform 同约定：行向量） */
function multiply(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/** 用矩阵变换一个轴对齐包围盒，返回变换后的轴对齐包围盒 */
function transformBox(m: number[], x0: number, y0: number, x1: number, y1: number): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ] as Array<[number, number]>) {
    const px = m[0] * x + m[2] * y + m[4];
    const py = m[1] * x + m[3] * y + m[5];
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface GeometryBoxes {
  /** 矢量绘图路径的包围盒 */
  paths: BBox[];
  /**
   * **位图**（嵌入图片）的放置包围盒。
   *
   * ── 为什么必须单独提取位图 ──
   * 图形区域检测原先只看矢量路径，隐含假设是「图表是画出来的」。
   * 但 ACL/出版排版里图表常常是**整张嵌入的 PNG/JPEG**——
   * 实测 ACL 样本全篇 17 页只有个位数条矢量路径，附录整页的图表
   * 一条都没有。结果图表标签全部漏进正文流（用户看到「附录的图
   * 被识别成了文字」）。
   *
   * PDF 里位图绘制在**单位正方形**上、由当时的 CTM 摆到页面位置，
   * 所以放置框 = 单位正方形过 CTM × 视口变换。
   */
  images: BBox[];
}

/** 判断一个算子编号是否是位图绘制 */
function isImageOp(fn: number, ids: OperatorIds): boolean {
  return (
    fn === ids.paintImageXObject ||
    fn === ids.paintImageXObjectRepeat ||
    fn === ids.paintInlineImageXObject ||
    fn === ids.paintImageMaskXObject ||
    fn === ids.paintJpegXObject
  );
}

/**
 * 遍历算子列表，输出矢量路径与位图放置在视口坐标下的包围盒。
 *
 * @param ops pdf.js `page.getOperatorList()` 的结果
 * @param viewportTransform `page.getViewport({scale}).transform`
 * @param ids pdf.js 的 OPS 枚举中本模块需要的编号
 */
export function geometryBoxesFromOperators(
  ops: OperatorListLike,
  viewportTransform: number[],
  ids: OperatorIds
): GeometryBoxes {
  let ctm: number[] = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const paths: BBox[] = [];
  const images: BBox[] = [];

  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];

    if (fn === ids.save) {
      stack.push(ctm);
    } else if (fn === ids.restore) {
      const prev = stack.pop();
      if (prev) ctm = prev;
    } else if (fn === ids.transform) {
      // 左乘：CTM_new = M × CTM_old（PDF 的 cm 语义）。写成右乘会让
      // 多层嵌套变换的页面整体偏移 —— 见文件头「累乘方向」。
      if (Array.isArray(args) && args.length === 6) ctm = multiply(args as number[], ctm);
    } else if (fn === ids.paintFormXObjectBegin) {
      stack.push(ctm);
      const matrix = args?.[0];
      if (Array.isArray(matrix) && matrix.length === 6) ctm = multiply(matrix, ctm);
    } else if (fn === ids.paintFormXObjectEnd) {
      const prev = stack.pop();
      if (prev) ctm = prev;
    } else if (fn === ids.constructPath) {
      // args = [ops, 坐标数组, minMax]；minMax 是 Float32Array，Array.isArray 为 false
      const minMax = args?.[2];
      if (!minMax) continue;
      const raw = [Number(minMax[0]), Number(minMax[1]), Number(minMax[2]), Number(minMax[3])];
      if (raw.some((v) => !Number.isFinite(v))) continue;
      // 视口变换是最后一步：v_viewport = v_user × CTM × viewportTransform
      paths.push(transformBox(multiply(ctm, viewportTransform), raw[0], raw[1], raw[2], raw[3]));
    } else if (isImageOp(fn, ids)) {
      // 位图绘制在单位正方形上，放置框 = 单位正方形 × CTM × 视口
      images.push(transformBox(multiply(ctm, viewportTransform), 0, 0, 1, 1));
    }
  }

  return { paths, images };
}

/** 兼容旧调用方：只要矢量路径 */
export function pathBoxesFromOperators(
  ops: OperatorListLike,
  viewportTransform: number[],
  ids: OperatorIds
): BBox[] {
  return geometryBoxesFromOperators(ops, viewportTransform, ids).paths;
}
