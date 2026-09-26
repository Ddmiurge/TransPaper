import { compose, type Matrix } from './matrix';
import type { BBox, RawTextItem } from '../types';

/**
 * 文本项包围盒高度相对字号的放大系数。
 *
 * pdf.js 给出的字号（tx[2]、tx[3] 的模）约等于字体的 em 尺寸，而一行文字的实际可视高度
 * 还包含上伸部与下伸部。1.15 是 I0 的初始猜测值 —— 调试层会目视校核，
 * 这是最可能的调参点：若 bbox 框不齐文字，改这一个常量。
 */
export const GLYPH_BOX_RATIO = 1.15;

/** 文本项在 viewport 坐标下的字号（px） */
export function fontSizeOf(item: RawTextItem, viewportTransform: Matrix, scale: number): number {
  const tx = compose(viewportTransform, item.transform as Matrix);
  return Math.hypot(tx[2], tx[3]) || item.height * scale;
}

/** 文本项在 viewport 坐标下的基线 y */
export function baselineOf(item: RawTextItem, viewportTransform: Matrix): number {
  const tx = compose(viewportTransform, item.transform as Matrix);
  return tx[5];
}

/**
 * 把 pdf.js 的文本项换算成 viewport 坐标下的包围盒。
 *
 * @param item              pdf.js TextItem
 * @param viewportTransform page.getViewport({scale}).transform
 * @param scale             viewport 缩放比例
 */
export function toBBox(item: RawTextItem, viewportTransform: Matrix, scale: number): BBox {
  const tx = compose(viewportTransform, item.transform as Matrix);
  const fontHeight = fontSizeOf(item, viewportTransform, scale);
  return {
    // tx[4]、tx[5] 是文本原点（基线左端）在 viewport 坐标下的位置
    x: tx[4],
    y: tx[5] - fontHeight, // 基线 → 上缘
    width: item.width * scale,
    height: fontHeight * GLYPH_BOX_RATIO,
  };
}

/**
 * 判断一段文字的变换矩阵是否含旋转/斜切。
 *
 * 水平排布的矩阵形如 `[fs, 0, 0, fs, x, y]` —— 第二、三分量恒为 0；
 * 旋转（含 90° 竖排）或斜切会让它们非零，量级与字号同阶
 * （旋转 90° 时 `|b| === fontSize`）。实测论文里的取值是 0 与 ±fontSize 两种极端，
 * 中间地带不存在，所以取相对字号的 5% 作阈值很宽裕。
 *
 * 放在域层而不是 pdf 层，是为了让**测试与生产共用同一个判据** ——
 * 各写一份迟早会漂移，届时测试通过而线上错误。
 *
 * 斜体不受影响：PDF 的斜体是**字体**属性，不会在矩阵里加倾斜分量。
 */
export function isRotatedTransform(transform: readonly number[]): boolean {
  const scale = Math.hypot(transform[0], transform[1]);
  if (!(scale > 0)) return false;
  return Math.abs(transform[1]) > scale * 0.05 || Math.abs(transform[2]) > scale * 0.05;
}
