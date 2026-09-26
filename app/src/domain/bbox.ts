import type { BBox } from '../types';

/**
 * 包围盒几何算子 —— 全项目唯一实现。
 *
 * ── 为什么必须有这个模块 ──
 * 「两个矩形相交 / 覆盖率 / 并集」是「图不被切碎、正文不被重复切」这条
 * 核心边界的数学底座。审查（CODE_AUDIT.md B1/B2）发现它曾被内联了
 * 7 处、并集写了 5 份 —— 任何一处判据调整都可能漏改其余，
 * 而症状是「某页的图又断了」这类极难定位的回归。
 * 判据只写一遍，改哪里都生效。
 */

/** 合并一组包围盒（空数组返回零矩形） */
export function unionBBox(boxes: BBox[]): BBox {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 两矩形是否相交（重叠面积为正；边缘接触不算） */
export function intersects(a: BBox, b: BBox): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** 两矩形的交集矩形；不相交返回 null */
export function intersectionRect(a: BBox, b: BBox): BBox | null {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return null;
  return { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), width: w, height: h };
}

/** 两矩形的交集面积（不相交为 0） */
export function intersectionArea(a: BBox, b: BBox): number {
  const r = intersectionRect(a, b);
  return r ? r.width * r.height : 0;
}

/**
 * inner 被 outer 覆盖的比例（按 inner 的面积归一）。
 * 这是「块是否整体落在图形区域内」类判据的标准口径。
 */
export function coverageRatio(inner: BBox, outer: BBox): number {
  const area = inner.width * inner.height;
  if (area <= 0) return 0;
  return intersectionArea(inner, outer) / area;
}

/**
 * 合并互相重叠的包围盒（一遍扫描 + 重复直到稳定）。
 * 区域数量很小，不值得更聪明的算法。
 */
export function mergeOverlapping(boxes: BBox[]): BBox[] {
  const out = [...boxes];
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i += 1) {
      for (let j = i + 1; j < out.length; j += 1) {
        if (!intersects(out[i], out[j])) continue;
        out[i] = unionBBox([out[i], out[j]]);
        out.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return out;
}
