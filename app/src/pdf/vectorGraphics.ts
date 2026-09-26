import * as pdfjsLib from 'pdfjs-dist';

import { geometryBoxesFromOperators, type OperatorIds } from './operatorPaths';
import type { BBox } from '../types';

/**
 * pdf.js 侧的薄封装：把一页的矢量绘图路径还原成视口坐标下的包围盒。
 *
 * 真正的计算在 `operatorPaths.ts`（纯逻辑、可在 Node 里测）；
 * 这里只负责拿到 getOperatorList() 并取出 OPS 枚举。
 */
export async function extractPathBoxes(page: any, scale: number): Promise<BBox[]> {
  const OPS = pdfjsLib.OPS as unknown as OperatorIds;
  const viewport = page.getViewport({ scale });
  const ops = await page.getOperatorList();
  return geometryBoxesFromOperators(ops, viewport.transform as number[], OPS).paths;
}

/**
 * 提取一页里**位图**（嵌入图片）的放置包围盒（视口坐标）。
 *
 * ACL 等出版排版的图表常是整张 PNG/JPEG，矢量路径为 0 ——
 * 不看位图就等于对这类论文关闭了图表检测。
 */
export async function extractImageBoxes(page: any, scale: number): Promise<BBox[]> {
  const OPS = pdfjsLib.OPS as unknown as OperatorIds;
  const viewport = page.getViewport({ scale });
  const ops = await page.getOperatorList();
  return geometryBoxesFromOperators(ops, viewport.transform as number[], OPS).images;
}
