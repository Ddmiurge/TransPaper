import type { BBox } from '../types';

/**
 * 判断一块裁切区域里是否有可见内容（非白像素）。
 *
 * 用途：段落之间的填充区在重排后应该交给 CSS 控制间距，而不是生成一堆纯白色的图像节点。
 * 只有真正含内容的区域（图表、公式、表格）才值得切成图像。
 *
 * 采样步长 16 字节（即每 4 个像素看 1 个），对"有没有墨水"这个二值判断足够，
 * 且比逐像素检查快一个数量级。
 */
export function canvasHasInk(canvas: HTMLCanvasElement, bbox: BBox, threshold = 248): boolean {
  const dpr = window.devicePixelRatio || 1;

  const x = Math.max(0, Math.floor(bbox.x * dpr));
  const y = Math.max(0, Math.floor(bbox.y * dpr));
  const w = Math.min(canvas.width - x, Math.ceil(bbox.width * dpr));
  const h = Math.min(canvas.height - y, Math.ceil(bbox.height * dpr));
  if (w <= 0 || h <= 0) return false;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return true; // 拿不到上下文时保守地认为有内容

  try {
    const data = ctx.getImageData(x, y, w, h).data;
    for (let i = 0; i < data.length; i += 16) {
      if (data[i] < threshold || data[i + 1] < threshold || data[i + 2] < threshold) {
        return true;
      }
    }
  } catch {
    return true;
  }
  return false;
}
