import type { BBox, Block } from '../types';
import { intersects, unionBBox, coverageRatio } from './bbox';

/**
 * 图形区域：从页面的**矢量路径**中挑出「属于图表的那部分」。
 *
 * ── 为什么用矢量路径，而不是像素 ──
 * 最初的实现是在渲染好的画布上采样「文字左右两侧有没有墨迹」。它不可靠：
 *   - 结果随缩放漂移（同一页在 100% / 150% / 200% 下判定不一致）；
 *   - 对「文字紧贴图形边缘」的情况失效 —— 采样环带正好落在图形外侧的空白上；
 *   - 没法在 Node 里测，只能靠开浏览器肉眼看。
 *
 * 改用矢量路径之后，这三个问题一起消失：
 *   - 判定是纯几何计算，与渲染无关，天然缩放无关；
 *   - 用的是图形自身的几何边界，不存在「环带落空」；
 *   - 完全不依赖 DOM/Canvas，可以直接在 Node 里做回归测试。
 *
 * 路径包围盒由 `src/pdf/vectorGraphics.ts` 提取（需要追踪 CTM 栈）。
 *
 * ── 为什么需要聚类 ──
 * 页面上的路径不都是图形。页脚分隔线、表格横线、装饰性短线都会产生路径。
 * 单条横线如果把附近的正文判成图内文字，是很糟糕的误判。
 * 因此这里先把路径按邻近关系聚成簇，只保留**规模足够大**的簇：
 * 真正的图表总有很多条路径（线段、箭头、方框），孤立的横线只有一两条。
 */

export interface FigureRegionOptions {
  /** 两个路径框的间距小于此值即视为同一图形的组成部分（px） */
  linkDistance: number;
  /** 一个簇至少要有这么多条路径才算图形 */
  minPathsPerCluster: number;
  /**
   * 路径数量超过此值时不再做 O(n²) 聚类，直接全部视为图形。
   * 一页上画出上千条路径的，必然是图（正常正文页只有 0–2 条）。
   */
  skipClusterAbove: number;
}

export const DEFAULT_FIGURE_REGION_OPTIONS: FigureRegionOptions = {
  linkDistance: 20,
  minPathsPerCluster: 4,
  skipClusterAbove: 1500,
};

function expand(box: BBox, pad: number): BBox {
  return {
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
}

/** 一个图形区域：由若干邻近路径构成的簇 */
export interface FigureCluster {
  /** 簇的整体包围盒 */
  bbox: BBox;
  /** 簇内路径条数 */
  pathCount: number;
}

/**
 * 把页面的路径按邻近关系聚成图形区域。
 *
 * 与 `figurePathBoxes` 的区别：那个返回**逐条路径**（用于「文字是否被图形夹住」的判定，
 * 需要精细到单条线）；这个返回**整个簇的包围盒**（用于把跨栏图形作为整体裁切）。
 */
export function figureClusters(
  paths: BBox[],
  options: Partial<FigureRegionOptions> = {}
): FigureCluster[] {
  const o = { ...DEFAULT_FIGURE_REGION_OPTIONS, ...options };
  if (paths.length === 0) return [];
  if (paths.length > o.skipClusterAbove) {
    const left = Math.min(...paths.map((b) => b.x));
    const top = Math.min(...paths.map((b) => b.y));
    const right = Math.max(...paths.map((b) => b.x + b.width));
    const bottom = Math.max(...paths.map((b) => b.y + b.height));
    return [{ bbox: { x: left, y: top, width: right - left, height: bottom - top }, pathCount: paths.length }];
  }

  const groups = clusterIndexes(paths, o);
  return groups
    .filter((members) => members.length >= o.minPathsPerCluster)
    .map((members) => ({
      bbox: unionBBox(members.map((i) => paths[i])),
      pathCount: members.length,
    }));
}

/** 并查集聚类，返回每个簇的成员下标 */
function clusterIndexes(paths: BBox[], o: FigureRegionOptions): number[][] {
  const parent = paths.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < paths.length; i += 1) {
    const probe = expand(paths[i], o.linkDistance);
    for (let j = i + 1; j < paths.length; j += 1) {
      if (intersects(probe, paths[j])) union(i, j);
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < paths.length; i += 1) {
    const root = find(i);
    const list = byRoot.get(root) ?? [];
    list.push(i);
    byRoot.set(root, list);
  }
  return [...byRoot.values()];
}
/**
 * 从页面的全部路径包围盒中，筛出属于图形的**逐条路径**。
 *
 * @param paths 页面矢量路径的包围盒（视口坐标）
 */
export function figurePathBoxes(
  paths: BBox[],
  options: Partial<FigureRegionOptions> = {}
): BBox[] {
  const o = { ...DEFAULT_FIGURE_REGION_OPTIONS, ...options };
  if (paths.length === 0) return [];
  if (paths.length > o.skipClusterAbove) return paths;

  const groups = clusterIndexes(paths, o);
  const keep = new Set<number>();
  for (const members of groups) {
    if (members.length >= o.minPathsPerCluster) members.forEach((i) => keep.add(i));
  }
  return paths.filter((_, i) => keep.has(i));
}

/**
 * 判断一段文字是否「被附近的图形夹住」（即位于图内或表内）。
 *
 * ── 判据 ──
 * 在该文字行的纵向范围内，左侧和右侧**各自都有**邻近的图形路径；
 * 或者在其横向范围内，上方和下方**各自都有**邻近的图形路径。
 * 两组条件满足任意一组即可。
 *
 * ── 为什么是「夹住」而不是「相交」 ──
 * 最初用的是「文字框与任意一条图形路径框相交」。它太宽松：实测第 1 页有一段
 * 10 行的正文，只是因为某个 formXObject 里的路径恰好从它左侧掠过，整段就被判成
 * 图内文字、保留为图像 —— 一段正文凭空消失，比误译严重得多。
 *
 * 而「左右被夹住」正文天然不满足：正文每行左右要么是页边距、要么是栏间空白。
 * 图内标签（在方框里）满足左右夹住；表格数据行满足上下夹住（行线就在文字上下几像素）。
 *
 * ── 为什么必须限制距离 ──
 * 不加距离限制时，「上下夹住」会误伤位于两张图之间的正文。图形与文字之间通常有
 * 20px 以上的留白，而表格行线紧贴文字（几个像素），`maxDistance` 正好把两者分开。
 */
export function isEnclosedByGraphics(
  bbox: BBox,
  figurePaths: BBox[],
  maxDistance: number
): boolean {
  if (figurePaths.length === 0) return false;

  const left = bbox.x;
  const right = bbox.x + bbox.width;
  const top = bbox.y;
  const bottom = bbox.y + bbox.height;

  /** 边缘是否落在目标位置的 ±maxDistance 内（允许少量重叠） */
  const near = (edge: number, target: number) =>
    edge >= target - maxDistance && edge <= target + maxDistance;

  let hasLeft = false;
  let hasRight = false;
  let hasAbove = false;
  let hasBelow = false;

  for (const path of figurePaths) {
    const pathRight = path.x + path.width;
    const pathBottom = path.y + path.height;

    // 左右夹住：路径必须与文字纵向相交
    if (path.y <= bottom && top <= pathBottom) {
      if (near(pathRight, left)) hasLeft = true;
      if (near(path.x, right)) hasRight = true;
    }

    // 上下夹住：路径必须与文字横向相交
    if (path.x <= right && left <= pathRight) {
      if (near(pathBottom, top)) hasAbove = true;
      if (near(path.y, bottom)) hasBelow = true;
    }

    if ((hasLeft && hasRight) || (hasAbove && hasBelow)) return true;
  }

  return false;
}

/**
 * 把图形区域扩展到包住其中的**文字标签**。
 *
 * ── 为什么必须做 ──
 * 矢量路径只覆盖图形里"画出来的部分"，而图内的**文字标签不产生路径**。
 * 于是图形的实际范围比路径包围盒更大，缺口恰好落在图的顶部或底部。
 *
 * 实测第 4 页的图 3（ResNet 架构对比图）：路径簇从 y=182 开始，
 * 但图内第一行标签 `output size: 224` / `3x3 conv, 64` 在 **y=158** 就有了。
 * 那 24px 因此落在「图形区域」之外，被当作**栏内空隙**处理，
 * 生成了一个**整栏宽**的切片（x 0→414）；而图主体来自图形并集（x 111→427）。
 *
 * 两个切片的宽度不同 → 按自身宽度缩放后居中位置不同 →
 * 视觉上就是「图被上下截成两段，还错位」。用户的原话是
 * 「要么右边部分被截掉，要么上下截成两个图错位」。
 *
 * ── 判据 ──
 * 只并入**字号明显小于正文**的文字。图注（约 0.9 倍正文）在图的**外面**，
 * 不能并进来 —— 否则图形区域会一路吞掉图注与后面的正文。
 *
 * @param regions 图形路径聚类得到的区域
 * @param items 页面文字项（含字号）
 * @param o.pad 文字与区域边缘的最大间距（px），超过就不算"在图里"
 * @param o.bodyFontSize 正文基准字号
 * @param o.maxFontRatio 并入字号上限（相对正文）。超过这个比例的文字不并入
 */
export function expandRegionsToText(
  regions: BBox[],
  items: Array<{ bbox: BBox } & { fontSize: number }>,
  o: { pad: number; bodyFontSize: number; maxFontRatio: number }
): BBox[] {
  if (regions.length === 0) return [];

  const near = (a: BBox, b: BBox, pad: number) =>
    a.x <= b.x + b.width + pad &&
    b.x <= a.x + a.width + pad &&
    a.y <= b.y + b.height + pad &&
    b.y <= a.y + a.height + pad;

  const grows = (a: BBox, b: BBox) =>
    a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height;

  const candidates = items.filter(
    (it) => o.bodyFontSize <= 0 || it.fontSize <= o.bodyFontSize * o.maxFontRatio
  );

  let current = regions.map((r) => ({ ...r }));
  // 迭代到稳定：并入一段文字后区域变大，可能又能罩住下一段
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const item of candidates) {
      const idx = current.findIndex((r) => near(r, item.bbox, o.pad));
      if (idx < 0) continue;
      const merged = unionBBox([current[idx], item.bbox]);
      if (grows(current[idx], merged)) {
        current[idx] = merged;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return current;
}

/**
 * 把落在图形区域**内部**的「正文块」重新标记为图像。
 *
 * ── 为什么必须有这一步 ──
 * analyzeTextStyle 的正文判定主要靠**字号**（图内标签通常是正文的
 * 0.33–0.79 倍）。但这个前提在两类页面上不成立：
 *
 *   1. **图表本身画得很大**（实测 2608.02657 第 27 页，附录里的 6 张
 *      ROC 曲线图缩放得比正文还大）：图内标签字号达到正文的 0.97–1.99 倍，
 *      字号判据完全反向 —— 标签成了「正文」甚至「二级标题」，
 *      用户看到的是附录里冒出一堆巨大的文字。
 *   2. **图表页几乎没有正文**：正文流被图表标签污染，重复切图自检
 *      报出几十个「正文同时以文本和图像出现」。
 *
 * 此时图形区域（矢量路径聚类 + 扩展）是唯一可靠的信号：
 * 一个「正文块」如果整体落在图形区域内部，它就是图内文字，
 * 无论字号多大。覆盖率阈值取 0.5 —— 图注等压在区域边缘的块
 * 不会被误吞。
 *
 * 必须在 analyzeTextStyle 与 expandRegionsToText 之后调用：
 * 它修正的是前两者的判定结果。
 */
export function remarkBodyBlocksInsideRegions(
  blocks: Block[],
  regions: BBox[],
  bodyBlockIds: Set<string>,
  minCoverage = 0.5
): number {
  if (regions.length === 0) return 0;

  let count = 0;
  for (const block of blocks) {
    // 公式块是正文流的有意成员（见 ADR-013），区域重标记不碰它
    if (!block.isBodyText || block.formula) continue;
    const covered = regions.some((r) => coverageRatio(block.bbox, r) >= minCoverage);
    if (!covered) continue;
    block.isBodyText = false;
    block.figureReason = 'graphics-region';
    bodyBlockIds.delete(block.id);
    count += 1;
  }
  return count;
}
