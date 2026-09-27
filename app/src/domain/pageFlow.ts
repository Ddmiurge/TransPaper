import { coveredColumnIndexes } from './columns';
import { coverageRatio, intersectionArea, intersectionRect, intersects, unionBBox } from './bbox';
import { anchorOf } from './overrides';
import type { BBox, Block, PageAnalysis, TextSpan } from '../types';

/**
 * 页面流重建 —— 把 PDF 重排成「单栏对照文档」
 *
 * ── 演进过程（这份注释记录的是踩过的坑，不要删）──
 * I0：整页 canvas + 译文浮层 → 译文压住原文（段间空隙仅 6–13px，译文要 105–205px）
 * I1：把页面切成图像条 + 译文块交替 → 不重叠了，但原文仍是**图片**，不能选中、像截图
 * I2（本版）：正文段落抽成 **HTML 文本**，只有图形区域保留为图像
 *
 * ── 现在做什么 ──
 * 页面被切成三类片段：
 *   text  —— 正文段落（Block.isBodyText = true）→ 渲染成 HTML，原文段 + 译文段
 *   image —— 图形区域（图表、公式、表格、页眉页脚，以及被判定为图内标签的文字）
 *            → 从整页离屏 canvas 按区域裁切，像素完全来自原始 PDF
 *   skip  —— 内容是跨栏元素的一部分，已在归属栏输出过，本栏跳过以免重复渲染
 *
 * ── 为什么"图内标签"能自动落进 image 而不是 text ──
 * 靠 Block.isBodyText（由 domain/textStyle.ts 判定）。
 * 实测论文里图内标签字号只有正文的一半，这个判据足够把它们挡在文本流之外，
 * 于是图表不会被拆散，也就天然满足「图片表格保持原样」。
 *
 * ── 明确不做（留给后续迭代）──
 *   ❌ 表格结构识别（表格区域整体作为图像保留）
 *   ❌ 公式识别（同上）
 *   ❌ 跨页段落
 *   ❌ 图片的语义居中 / 图注配对
 */

export interface FlowSlice {
  kind: 'slice';
  id: string;
  /** 在整页 canvas 坐标中的裁切区域 */
  source: BBox;
  /**
   * 「跟随正文字号」缩放（行间公式用）。
   *
   * 图形切片的默认行为是**放大到排版行宽**（MAX_SLICE_BOOST 兜底）——
   * 那是插图的常规做法。公式不行：`y = F(x)+x` 被拉到整行宽会大得离谱。
   * 这个标记告诉渲染层：按 `baseFontSize / bodyFontSize` 缩放，
   * 让公式的字面高度与两侧正文一致。
   */
  scaleToText?: boolean;
}

/** 正文段落：原文与译文紧邻呈现 */
export interface FlowText {
  kind: 'text';
  id: string;
  blockId: string;
  source: string;
  /** 原文的样式片段（粗细 / 斜体），偏移相对 source */
  spans: TextSpan[];
  target: string | null;
  /**
   * 是否送去翻译。false 表示这是「保留为文本但不翻译」的内容（参考文献、页码）。
   *
   * 渲染层据此换用文献的排版（悬挂缩进、字号略小、行距更紧），
   * 也就是让它看起来仍像一份文献表，而不是一堆普通段落。
   */
  translatable: boolean;
  /** 不翻译的原因，供渲染层选择样式与提示 */
  nonTranslatableReason: Block['nonTranslatableReason'];
  /** 0 = 正文，1 = 三级标题，2 = 二级标题 */
  headingLevel: number;
  bold: boolean;
  /** 原文字号相对本页正文字号的倍率，用于按比例还原视觉层级 */
  fontScale: number;
  /** 版面宽度（该栏内容宽） */
  width: number;
  /**
   * 改判锚点（I18 手动改判）。右键菜单据此定位这条块，与块 id 的序号性解耦。
   */
  anchor: string;
  /** 当前是否被手动改判及其类型；null = 自动判定。渲染层据此标注 */
  overridden: string | null;
}

export type FlowNode = FlowSlice | FlowText;

export interface FlowStats {
  sliceCount: number;
  textCount: number;
  /** 带译文的段落数 */
  translatedCount: number;
  /** 段数中属于正文流的比例 */
  bodyTextRatio: number;
  /** 因内容在别栏输出而跳过的区间数（跨栏元素造成） */
  skippedIntervalCount: number;
  /** 峰值宽度 */
  contentWidth: number;
  /** 图像切片覆盖的纵向高度总计 */
  coveredHeight: number;
  /**
   * 被切成多片（且中间插进了译文）的图形区域数量（应当为 0）。
   *
   * 这是用户反复反馈的「有的图是断的」的量化形式。
   */
  splitFigureCount: number;
  /**
   * 正文块的面积被图像切片覆盖了多少（应当为 0）。
   *
   * 不为 0 意味着同一段正文会在页面上**出现两次**：一次是重排后的 HTML 文本，
   * 一次是切片图像里的像素 —— 用户看到的就是「原文被一起切进图里了」。
   *
   * 为什么必须有这个指标：它是「图形该切、正文不该切」这条边界的守门人。
   * 之前只盯「图形有没有漏切」（uncoveredGraphicCount），却没有盯反向的
   * 「正文有没有被多切」—— 而后者在视觉上更刺眼。
   */
  duplicatedTextArea: number;
  /** 被图像切片覆盖到的正文块数量（配合 duplicatedTextArea 定位用） */
  duplicatedBlockCount: number;
  /**
   * 被丢弃的纯空白高度合计。
   *
   * 与 `coveredHeight` 对照看：重排后的页面高度里，真正的图像内容有多少、
   * 被省掉的留白有多少。这个数字应该远大于 0 —— 如果它接近 0，
   * 说明留白又被切成图像了（旧实现的行为）。
   */
  droppedGapHeight: number;
  /**
   * 有多少条图形路径**没有被任何切片完整覆盖**。
   *
   * 这是「图表有没有被切碎 / 有没有像素漏掉」的量化指标，应当为 0。
   *
   * 为什么需要它：切片是按「行」切出来的，而被抽成正文的段落会把所在行段从图像里
   * 挖掉。如果一个图形恰好与某个正文段落的包围盒在纵向重叠（典型情形：**图注文字
   * 落在图的纵向范围之内**），这个图形就会被切成两半，落在正文块包围盒里的那部分
   * 像素既不在任何切片里、也不会被渲染成文字，于是**凭空消失**。
   * 光看截图很难发现漏了几像素，把它变成数字才能守住。
   */
  uncoveredGraphicCount: number;
  /** 被部分覆盖（横跨切片边界）的图形路径数，属正常，仅作对照 */
  partiallyCoveredGraphicCount: number;
}

export interface PageFlow {
  pageIndex: number;
  pageWidth: number;
  pageHeight: number;
  nodes: FlowNode[];
  stats: FlowStats;
  /**
   * 本页正文字号（页面坐标单位）。
   *
   * 渲染层用它把「页面上 15pt 的公式」换算成「重排文档里 16.8px 的公式」：
   * 缩放系数 = baseFontSize / bodyFontSize。没有这个基准，
   * 公式切片在任何缩放档位下都只能按原始像素显示，字号对不上正文。
   */
  bodyFontSize: number;
}

type BandKind = 'image' | 'text' | 'skip';

interface Band {
  kind: BandKind;
  y0: number;
  y1: number;
  sourceX: number;
  width: number;
  block?: Block;
  /** 行间公式段：直接输出为 scaleToText 切片，不参与 run 合并（见下方 emit 处） */
  formula?: boolean;
}

export interface PageFlowOptions {
  /**
   * **文档级**重排行宽基准（可选）。
   *
   * ── 为什么不能只用本页的 contentBounds ──
   * 重排行宽取「本页内容边界宽」—— 隐含假设是每页内容都铺满版心。
   * 附录的收尾页常常只有半栏有字（实测 ACL 样本第 17 页：内容只占
   * 页宽 37%），行宽随之缩成一半，观感是「段落居中、没铺满」；
   * 而且同一文档里各页行宽不一致，翻页时行长跳变。
   *
   * 调用方传入「全文档已见页面的最大内容宽」—— 每页排布时用它
   * （与本页内容宽取较大者），行宽就稳定了。
   */
  readingWidth?: number;

  /**
   * 判断一个裁切区域内是否有可见内容（非白像素）。
   *
   * 由调用方注入（通常基于离屏 canvas 采样）。用途：丢弃段落之间的**纯空白**填充区，
   * 让段落间距交给 CSS 控制，而不是生成一堆纯白色的图像节点。
   *
   * 未提供时一律视为有内容 —— 这会让所有填充区都生成图像切片。
   */
  hasContent?: (bbox: BBox) => boolean;

  /**
   * 本页图形路径的包围盒（由渲染层注入，见 pdf/vectorGraphics.ts）。
   * 用于 `stats.uncoveredGraphicCount` 自检，以及把裁切范围扩到图形边界。
   */
  figurePaths?: BBox[];

  /**
   * 本页**全部**图形区域（`figureClusters` 的包围盒）。
   *
   * 为什么传全部而不是只传跨栏的：「是否跨栏」需要栏边界信息，
   * 而栏边界只有域层知道 —— 让调用方去判断，等于把同一份几何算两遍，
   * 迟早漂移。域层内部自己筛出跨栏的那部分。
   *
   * 这些区域同时用于 `stats.splitFigureCount` 自检：
   * 一张图被切成上下两片、中间插进一段译文，读起来就是「图断了」。
   */
  figureRegions?: BBox[];

  /**
   * 小于此高度的片段直接丢弃（px）。
   *
   * 默认值曾只有 3px，于是「空隙里检测到一条细线」也会生成一个切片 ——
   * 实测第 4 页右栏出现了 5 个 9–14px 高、整栏宽（504px）的细条，
   * 在页面上就是几条无意义的小横条，把正文切得支离破碎。
   * 论文正文里不存在横穿整栏的细线；这类孤立路径多为装饰线或表格残留。
   *
   * 提到 20px：真正的图形区域（矢量簇）动辄数百像素高，不受影响。
   */

  minSegmentHeight?: number;

  /**
   * 当前文档的手动改判（I18）。键 = 改判锚点（anchorOf）。
   * 只用于给文本节点打 `overridden` 标记；块本身的改判由调用方在
   * analyzePage 之后应用（见 domain/overrides.ts 的 applyOverrides）。
   */
  overrides?: ReadonlyMap<string, import('./overrides').OverrideKind>;
}

export function buildPageFlow(
  analysis: PageAnalysis,
  // 用 ReadonlyMap 而不是 Map：调用方传进来的是「订阅到的译文快照」，
  // 本函数只读不写，把这一点写进类型能防住误改
  translations: ReadonlyMap<string, string>,
  options: PageFlowOptions = {}
): PageFlow {
  const { columnBoundaries, blocks, pageIndex } = analysis;
  const columnCount = Math.max(1, columnBoundaries.length - 1);
  const minHeight = options.minSegmentHeight ?? 20;

  const nodes: FlowNode[] = [];
  let skippedIntervalCount = 0;
  let coveredHeight = 0;
  /** 被丢弃的纯空白高度合计 —— 用来确认「间距交给 CSS」确实生效 */
  let droppedGapHeight = 0;
  let sliceSeq = 0;
  let textSeq = 0;
  let formulaSeq = 0;

  // 重排后正文的排版宽度：用跨栏的整幅内容宽度，而不是原来某一栏的宽度。
  // 否则重排出来的文档只有半页宽，读起来会不停地折行。
  // 文档级基准（见 PageFlowOptions.readingWidth）与本页内容宽取较大者：
  // 收尾页只有半栏内容时，仍按文档的常规行宽排。
  const readingWidth = Math.max(
    options.readingWidth ?? 0,
    analysis.contentBounds.width > 0 ? analysis.contentBounds.width : analysis.width
  );

  /**
   * 排布的障碍物：正文块 + 跨栏图形区域。
   *
   * 统一成同一个结构，是为了让「跨栏元素用自身宽度裁切、且只输出一次」这套逻辑
   * 对两者都生效 —— 跨栏标题本来就是这么处理的，跨栏图形没有理由不一样。
   */
  /**
   * 一个矩形有多大比例落在图形区域内。
   *
   * 用它判断「这个块是不是本来就属于某张图」。纯几何，不含阈值调参的主观性。
   */
  const figureCoverage = (bbox: BBox): number => {
    const area = bbox.width * bbox.height;
    if (area <= 0) return 0;
    let covered = 0;
    for (const region of options.figureRegions ?? []) {
      covered += intersectionArea(bbox, region);
    }
    return covered / area;
  };

  /**
   * 判定为「图内文字」的块，如果它确实落在图形区域内，就不该再单独成为障碍。
   *
   * ── 这一条修的是「图被上下截成两段还错位」──
   * 实测第 4 页：图 3 的第一行标签 `image image image output 3x3 conv, 64 size: 224`
   * 被聚成了一个独立的块（x 76→366, y 136→182，高 46px）。它作为障碍**抢占了
   * y 136–182 这一段**，图形区域（y 136→907）只能从 182 开始输出。
   *
   * 于是同一张图被切成两片，而且两片的横向范围不同：
   *   - 切片 A 来自那个文字块 → 用**整栏宽**（x 0→414）
   *   - 切片 B 来自图形区域 → 用**图形并集**（x 111→427）
   * 宽度不同，按自身宽度缩放后居中位置也就不同 —— 用户看到的正是
   * 「上下截成两个图错位」，而且图顶那行标签还会以「窄条」的形式单独出现。
   *
   * 判据只针对**非正文块**：正文块即便与图形区域有交叠（多半是判定误差），
   * 也应该照常输出为可读文本，由 `duplicatedTextArea` 自检盯着。
   */
  const absorbedByFigure = (block: Block): boolean =>
    !block.isBodyText && figureCoverage(block.bbox) > 0.3;

  const obstacles: Array<{
    bbox: BBox;
    isBodyText: boolean;
    block?: Block;
    covered: number[];
    home: number;
    /**
     * 是否来自**跨栏图形**（而非跨栏正文块，例如横跨两栏的标题）。
     *
     * 两者在非归属栏的处理必须区分：
     *   - 跨栏正文块：它在本栏的像素也属于自己（标题的右半就在右栏），
     *     所以非归属栏要留 skip 区间，避免那段区域再产出别的内容
     *   - 跨栏图形：裁切范围已限制在「本纵向带的图形并集」内、不覆盖别的栏，
     *     所以非归属栏**不该**为它留位 —— 否则会以 skip 吞掉该栏的正文
     */
    isSpanningFigure: boolean;
    /**
     * 来自**绕排图形区域**（图占版面的一部分、正文从旁边绕过去）。
     *
     * ── 为什么绕排图必须成为障碍 ──
     * 单栏图形默认靠「正文块之间的空隙」裁切，裁的是整栏宽 ——
     * 那要求图的上下都没有正文。绕排图不满足：实测 2608.02657 第 8 页，
     * 图占右半边（x489→756），正文从左边绕过去，文本块的 y 区间
     * **盖住了图的整个 y 范围** —— 空隙不存在，图的像素从未被裁切
     * （自检报「切图高度 0px / 7 条路径未覆盖」，整张图凭空消失）。
     *
     * 成为障碍后它按**自身 x 范围**裁切，旁边的正文照常输出文本 ——
     * 两者 x 不相交，互不干扰。
     */
    isFigureRegion: boolean;
  }> = [
    ...blocks
      .filter((block) => !absorbedByFigure(block))
      .map((block) => {
        // 公式块的包围盒要**向下/上扩一点**：文本项的 bbox 只到基线附近，
        // 而公式的字形经常超出 —— 求和/积分的上下限、分式的横线。
        // LaTeX 的 display skip 有 0.7em 以上，扩 0.35em 不会碰到相邻段。
        // 不扩的后果实测可见：公式顶部的求和号被齐腰切掉。
        const pad = block.formula ? block.fontSize * 0.35 : 0;
        const bbox: BBox = pad
          ? {
              x: block.bbox.x,
              y: block.bbox.y - pad,
              width: block.bbox.width,
              height: block.bbox.height + pad * 2,
            }
          : block.bbox;
        const covered = coveredColumnIndexes(bbox, columnBoundaries);
        return {
          bbox,
          isBodyText: block.isBodyText,
          block,
          covered,
          home: covered[0] ?? 0,
          isSpanningFigure: false,
          isFigureRegion: false,
        };
      })
      .filter((m) => m.covered.length > 0),
    ...(options.figureRegions ?? [])
      .filter((bbox) => {
        // 跨栏判定在域层做：同时覆盖 ≥2 栏才算跨栏。
        // 附加条件：**与正文块纵向重叠**的区域也必须成为障碍（绕排图，见
        // isFigureRegion 的注释）—— 否则它的 y 范围被正文块盖住，
        // 空隙裁切永远不会发生，整张图丢失。
        const covered = coveredColumnIndexes(bbox, columnBoundaries);
        if (covered.length >= 2) return true;
        const regionArea = bbox.width * bbox.height;
        if (regionArea <= 0) return false;
        return (
          blocks.some(
            (b) =>
              b.isBodyText &&
              // 覆盖率按**区域自身**算：图被正文块碰到一角就该走障碍路径
              intersectionArea(b.bbox, bbox) / regionArea > 0.3
          )
        );
      })
      .map((bbox) => {
        // 「是否跨栏」用**原始包围盒**判断（不能用扩展后的宽度，否则任何单栏图形
        // 都会被扩成通栏、过滤器形同虚设 —— 这个 bug 是单测抓到的）。
        const covered = coveredColumnIndexes(bbox, columnBoundaries);

        // 裁切范围 = 本纵向带内**全部图形路径的并集** x 范围。
        //
        // 两个错误的极端都试过，这里取中间：
        //   - 用簇自身的窄包围盒 → 同带内、簇之外的图形失去覆盖（第 4 页 33 → 229 条未覆盖）
        //   - 用整幅版心（contentBounds）→ **把别的栏的正文也切了进来**
        //
        // 第二个错误是用户实际看到的：第 4 页的架构图 x 只到 427，而栏缝在 414，
        // 仅超出 13px 就被判为跨栏元素，裁切范围随之扩到 75→818，
        // 右栏 7 段正文（x 463→818）全被切进图像 —— 而它们同时又以 HTML 文本出现，
        // 于是「原文被一起切进图里了」，同一段文字在页面上出现两次。
        //
        // 并集既能覆盖同带内的其他图形（原本扩到版心的目的），又不会外溢到别的栏。
        const band = (options.figurePaths ?? []).filter(
          (p) => p.y + p.height > bbox.y && p.y < bbox.y + bbox.height
        );
        const left = band.length > 0 ? Math.min(...band.map((p) => p.x)) : bbox.x;
        const right =
          band.length > 0 ? Math.max(...band.map((p) => p.x + p.width)) : bbox.x + bbox.width;
        const full = { x: left, y: bbox.y, width: right - left, height: bbox.height };
        return {
          bbox: full,
          isBodyText: false,
          covered,
          home: covered[0] ?? 0,
          isSpanningFigure: true,
          isFigureRegion: true,
        };
      })
      // 只处理真正跨栏的或与正文重叠的；其余单栏图形由所在栏的空隙裁切覆盖
      .filter(
        (m) =>
          m.covered.length >= 2 ||
          blocks.some((b) => b.isBodyText && coverageRatio(b.bbox, m.bbox) > 0.3)
      ),
  ];

  // ── 公式簇合并 ──
  //
  // display 公式环境的各部分（主式、残块、求和上下限、上标编号）在提取后
  // 是**多个 y 区间互相重叠的块**（见 formulas.ts 的 absorbFormulaFragments）。
  // 若各裁各的，重叠区间会被游标截断（后一个裁切从游标处开始，
  // 顶部字形被切掉）；合并成一个障碍、一次裁切，才是完整公式。
  //
  // 合并条件（刻意收紧）：两者都是「块衍生的障碍」，至少一个是公式，
  // 且另一个不是普通正文（正文块绝不能被吞进公式图像 —— 文本流会丢内容）。
  {
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < obstacles.length; i += 1) {
        const a = obstacles[i];
        const aFormula = a.block?.formula === true;
        if (!aFormula) continue;
        for (let j = 0; j < obstacles.length; j += 1) {
          if (j === i) continue;
          const b = obstacles[j];
          if (!b.block) continue; // 只合并块衍生的障碍
          if (!(b.block.formula || !b.isBodyText)) continue; // 普通正文不吞
          if (!intersects(a.bbox, b.bbox)) continue;
          a.bbox = unionBBox([a.bbox, b.bbox]);
          a.isBodyText = false;
          obstacles.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    // 跨栏**图形**只在归属栏参与排布。
    //
    // 否则它会在非归属栏以「skip 片段」的形式把该栏整个 y 区间吞掉：
    // 实测第 4 页的跨栏图形 y 146→926，右栏的 4 段正文（y 379/630/763/792）
    // 全落在它之后，被 skip 一并吃掉 —— 正文凭空消失。
    // 它的像素已由归属栏那一次裁切覆盖（裁切范围是跨栏的并集），
    // 其他栏不需要、也不应该再为它留位。
    //
    // 跨栏**正文块**（如横跨两栏的标题）不在此列：它在非归属栏的像素也属于自己，
    // 必须继续留 skip 区间。
    const columnMeta = obstacles.filter((m) =>
      m.isSpanningFigure ? m.home === columnIndex : m.covered.includes(columnIndex)
    );
    if (columnMeta.length === 0) continue;

    // 裁切范围只由「归属本栏且不跨栏」的块决定 —— 否则一个宽标题会把整栏切片都撑宽
    const boundsSource = columnMeta.filter((m) => m.home === columnIndex && m.covered.length === 1);
    const left = Math.min(columnBoundaries[columnIndex], ...boundsSource.map((m) => m.bbox.x));
    const right = Math.max(
      columnBoundaries[columnIndex + 1],
      ...boundsSource.map((m) => m.bbox.x + m.bbox.width)
    );
    const columnWidth = Math.max(1, right - left);

    // 裁切范围必须**同时**覆盖正文块与本栏内的图形。
    //
    // 曾经的实现只看正文块，于是两类像素会凭空消失：
    //   - 图形延伸到最上面/最下面那个正文块之外的条带
    //   - 图形落在某个正文块纵向范围内的部分（典型情形：图注文字压在图的纵向区间里，
    //     图会被切开，被图注「挖走」的那一段既不在切片里、也没被渲染成文字）
    //
    // 这是最隐蔽的一类缺陷：漏的不是文字，是图的像素，光看文字输出永远发现不了。
    const columnFigures = (options.figurePaths ?? []).filter(
      (path) => path.x + path.width > left && path.x < right
    );
    const top = Math.min(
      ...columnMeta.map((m) => m.bbox.y),
      ...columnFigures.map((path) => path.y)
    );
    const bottom = Math.max(
      ...columnMeta.map((m) => m.bbox.y + m.bbox.height),
      ...columnFigures.map((path) => path.y + path.height)
    );

    // ── 第一步：把本栏纵向切成互不重叠的片段 ──
    const intervals = columnMeta
      .map((m) => {
        const isHome = m.home === columnIndex;
        const isSpanning = m.covered.length >= 2;
        // 绕排图形区域也按自身宽度裁切（见 isFigureRegion 的注释）——
        // 否则整栏宽的裁切会把旁边绕排的正文像素也切进图里。
        // 公式簇同理：整栏宽的白条会把公式两侧的整片页边距都带进来，
        // 视觉上是一条比正文行宽还宽的白带（实测 2608.02657 第 4 页）。
        const useOwnWidth = (isSpanning || m.isFigureRegion || m.block?.formula === true) && isHome;
        // 抽成文本的条件：归属本栏、被判定为正文流、且**不是行间公式**。
        // 「是否落在图形区域内」已在 analyzePage 内判定完毕并写入 block.isBodyText，
        // 这里不再做第二次判断 —— 同一个信号判两次，只会让结果随渲染环境漂移。
        // 公式例外：文本化对公式必然有损（上下标拍平、符号缺字形），
        // 它有独立的裁切区间，回退到图像切片像素才有保证（见 markFormulas）。
        const asText = isHome && m.isBodyText && !m.block?.formula;
        return {
          y0: m.bbox.y,
          y1: m.bbox.y + m.bbox.height,
          emit: isHome,
          asText,
          block: asText ? m.block : undefined,
          formula: !asText && m.block?.formula === true,
          // 绕排区域的 y 范围与正文块重叠是**预期**（正文从旁边绕过去），
          // 不做游标截断 —— 否则图的顶部会被前面正文区间的末端切掉。
          // 文本节点输出的是完整块文本，与裁切无关；两者 x 不相交，像素不重复。
          noClamp: m.isFigureRegion,
          sourceX: useOwnWidth ? m.bbox.x : left,
          width: useOwnWidth ? m.bbox.width : columnWidth,
        };
      })
      .sort((a, b) => a.y0 - b.y0 || a.y1 - b.y1);

    const bands: Band[] = [];
    let cursor = top;

    /**
     * 该纵向空隙里是否真的有图形。
     *
     * 判据用几何（图形路径的包围盒）而不是读像素 —— 这是踩过坑之后的结论：
     * 像素判据会被相邻文本块的边缘像素触发（空隙的下沿紧贴文本块包围盒，
     * 而包围盒的下沿往往还含一点字形余量），于是「留白」与「图形」区分不开，
     * 实测第 1 页 9 个切片里有 7 个是纯白色。几何判据还能在 Node 里离线测试。
     *
     * 只有在调用方**完全没有**提供 figurePaths 时才退回「一律切图」——
     * 那是解析信息缺失的降级路径，宁可多切也不能把图丢了。
     */
    const figurePaths = options.figurePaths ?? [];
    const hasFigureInfo = options.figurePaths !== undefined;
    const gapHasFigure = (y0: number, y1: number) =>
      !hasFigureInfo ||
      figurePaths.some(
        (p) => p.y + p.height > y0 + 0.5 && p.y < y1 - 0.5 && p.x + p.width > left && p.x < right
      );

    for (const iv of intervals) {
      if (iv.y0 > cursor) {
        // 空隙：只有真的含图形时才切成图像，否则直接跳过，让 CSS 控制段间距。
        // 无条件切图的旧实现会把段落之间的留白变成一堆纯白图像节点 ——
        // 页面上因此出现莫名的空白，「间距交给 CSS」的设计意图完全落空。
        if (gapHasFigure(cursor, iv.y0)) {
          bands.push({ kind: 'image', y0: cursor, y1: iv.y0, sourceX: left, width: columnWidth });
        } else {
          // 必须压成一个 skip 片段，而不是「什么都不生成」——
          // 正文片段结束后会开启一个图像 run，这里若不留断点，
          // 这个 run 会一路延续到下一个正文片段，把留白又切了进去。
          // （这个坑是单测抓到的：只删掉 image 片段，切片数量并没有减少。）
          bands.push({ kind: 'skip', y0: cursor, y1: iv.y0, sourceX: left, width: columnWidth });
          droppedGapHeight += iv.y0 - cursor;
        }
      }
      const start = iv.noClamp ? iv.y0 : Math.max(cursor, iv.y0);
      if (iv.y1 > start) {
        if (!iv.emit) {
          bands.push({ kind: 'skip', y0: start, y1: iv.y1, sourceX: iv.sourceX, width: iv.width });
          skippedIntervalCount += 1;
        } else {
          bands.push({
            kind: iv.asText ? 'text' : 'image',
            y0: start,
            y1: iv.y1,
            sourceX: iv.sourceX,
            width: iv.width,
            block: iv.block,
            // 标记必须跟着 segment 走：interval 上的 flag 不带过来，
            // 第二趟循环就认不出公式段（测试抓到的正是这个断点）
            formula: iv.formula,
          });
        }
        cursor = iv.y1;
      }
    }
    if (cursor < bottom) {
      // 尾巴同理：只有本栏底部这一段真的含图形时才保留
      if (gapHasFigure(cursor, bottom)) {
        bands.push({ kind: 'image', y0: cursor, y1: bottom, sourceX: left, width: columnWidth });
      } else {
        droppedGapHeight += bottom - cursor;
      }
    }

    // ── 第二步：合并连续图像片段成切片，遇到正文段落则输出文本节点 ──
    let runStart: number | null = null;
    let runX = left;
    let runWidth = columnWidth;

    const flushRun = (end: number) => {
      if (runStart === null) return;
      const height = end - runStart;
      if (height >= minHeight) {
        const crop: BBox = { x: runX, y: runStart, width: runWidth, height };
        if (!options.hasContent || options.hasContent(crop)) {
          nodes.push({ kind: 'slice', id: `p${pageIndex}-c${columnIndex}-s${sliceSeq}`, source: crop });
          sliceSeq += 1;
          coveredHeight += height;
        }
      }
      runStart = null;
    };

    const startRun = (y: number, x: number, w: number) => {
      runStart = y;
      runX = x;
      runWidth = w;
    };

    for (const seg of bands) {
      if (seg.kind === 'skip') {
        flushRun(seg.y0);
        continue;
      }

      if (seg.kind === 'text') {
        flushRun(seg.y0);
        const block = seg.block;
        if (block) {
          const target = translations.get(block.id) ?? null;
          const anchor = anchorOf(block);
          nodes.push({
            kind: 'text',
            id: `p${pageIndex}-c${columnIndex}-x${textSeq}`,
            blockId: block.id,
            source: block.text,
            spans: block.spans,
            translatable: block.translatable,
            nonTranslatableReason: block.nonTranslatableReason,
            target,
            headingLevel: block.headingLevel,
            bold: block.bold,
            fontScale: block.fontScale,
            width: readingWidth,
            anchor,
            overridden: options.overrides?.get(anchor) ?? null,
          });
          textSeq += 1;
        }
        startRun(seg.y1, seg.sourceX, seg.width);
        continue;
      }

      // 行间公式：**直接输出**为带 scaleToText 标记的切片，不进 run 合并。
      // run 合并的产物是「匿名切片」，携带不了公式的缩放语义 ——
      // 测试抓到过：公式切片混进 run 后 scaleToText 丢失，渲染层只能按插图方式拉满行宽。
      // 裁切范围 = 公式段自身（已含 0.35em 垂直余量），横向用整栏宽，
      // 保留原公式在栏内的水平位置（居中 / 右对齐的编号）。
      if (seg.formula) {
        flushRun(seg.y0);
        const crop: BBox = { x: seg.sourceX, y: seg.y0, width: seg.width, height: seg.y1 - seg.y0 };
        if (!options.hasContent || options.hasContent(crop)) {
          nodes.push({
            kind: 'slice',
            id: `p${pageIndex}-c${columnIndex}-f${formulaSeq}`,
            source: crop,
            scaleToText: true,
          });
          formulaSeq += 1;
          coveredHeight += crop.height;
        }
        continue;
      }

      // 图像片段：若裁切范围变化必须先断开，否则切片会串栏
      if (runStart !== null && (seg.sourceX !== runX || seg.width !== runWidth)) {
        flushRun(seg.y0);
      }
      if (runStart === null) startRun(seg.y0, seg.sourceX, seg.width);
    }

    flushRun(bottom);
  }

  const contentWidth = nodes.reduce(
    (max, n) => Math.max(max, n.kind === 'slice' ? n.source.width : n.width),
    0
  );

  const textNodes = nodes.filter((n): n is FlowText => n.kind === 'text');
  const bodyBlocks = blocks.filter((b) => b.isBodyText).length;

  // 图形覆盖自检：每条图形路径有多少面积被切片覆盖。
  //
  // 判据用**面积**而不是「是否落在同一个切片内」：一条图形横跨两个相邻切片时，
  // 后一种判法会误报成未覆盖。采样 5×5 网格，够用且不必实现矩形求交。
  const slices = nodes.filter((n): n is FlowSlice => n.kind === 'slice');
  const SAMPLE = 5;
  const isCovered = (x: number, y: number) =>
    slices.some(
      (slice) =>
        x >= slice.source.x - 1 &&
        x <= slice.source.x + slice.source.width + 1 &&
        y >= slice.source.y - 1 &&
        y <= slice.source.y + slice.source.height + 1
    );
  // 正文被重复切进图像的面积。
  // 只统计「显著重叠」—— 正文块的包围盒下沿含一点字形余量，
  // 与相邻切片有 1–2px 的边界接触属正常，按面积占比过滤掉。
  // 公式块是 bodyText 但**有意**以切片输出，不算重复。
  // 这条自检盯的是「正文被意外切进图里」，公式的图像化是判定结果而非事故。
  const textBlocks = blocks.filter((b) => b.isBodyText && !b.formula);
  let duplicatedTextArea = 0;
  let duplicatedBlockCount = 0;
  for (const block of textBlocks) {
    let overlapArea = 0;
    for (const slice of slices) {
      const overlap = intersectionRect(block.bbox, slice.source);
      if (!overlap) continue;
      // 绕排图的例外：正文块的**包围盒**会盖住图所在的那半边（正文在另一半边
      // 绕排，bbox 是所有行并出来的），与图的切片在 bbox 层面重叠，
      // 但实际文字像素并不在切片里。重叠部分若落在图形区域内，
      // 说明是区域「解释得了」的像素，按面积扣除而不是整块豁免。
      let regionCovered = 0;
      for (const r of options.figureRegions ?? []) {
        regionCovered += intersectionArea(overlap, r);
      }
      overlapArea += Math.max(0, overlap.width * overlap.height - regionCovered);
    }
    const blockArea = block.bbox.width * block.bbox.height;
    if (blockArea > 0 && overlapArea / blockArea > 0.05) {
      duplicatedTextArea += overlapArea;
      duplicatedBlockCount += 1;
    }
  }

  // 图形区域被切成了几片。
  //
  // 判据：某个图形区域与 ≥2 个切片相交，且这些切片之间还夹着文本节点。
  // 后者是关键 —— 只是「横跨两个相邻切片」属正常（切片按行切），
  // 但**中间插进一段译文**就说明图被从中间劈开了，读起来就是「图断了」。
  let splitFigureCount = 0;
  for (const region of options.figureRegions ?? []) {
    const hitSlices = nodes
      .map((n, index) => ({ n, index }))
      .filter(({ n }) => {
        if (n.kind !== 'slice') return false;
        const b = n.source;
        return intersects(b, region);
      });
    if (hitSlices.length < 2) continue;
    const first = hitSlices[0].index;
    const last = hitSlices[hitSlices.length - 1].index;
    const hasTextBetween = nodes
      .slice(first + 1, last)
      .some((n) => n.kind === 'text' && n.target !== null);
    if (hasTextBetween) splitFigureCount += 1;
  }

  let uncoveredGraphicCount = 0;
  let partiallyCoveredGraphicCount = 0;
  for (const path of options.figurePaths ?? []) {
    let covered = 0;
    for (let i = 0; i < SAMPLE; i += 1) {
      for (let j = 0; j < SAMPLE; j += 1) {
        const x = path.x + (path.width * (i + 0.5)) / SAMPLE;
        const y = path.y + (path.height * (j + 0.5)) / SAMPLE;
        if (isCovered(x, y)) covered += 1;
      }
    }
    if (covered === 0) uncoveredGraphicCount += 1;
    else if (covered < SAMPLE * SAMPLE) partiallyCoveredGraphicCount += 1;
  }

  return {
    pageIndex,
    pageWidth: analysis.width,
    pageHeight: analysis.height,
    nodes,
    // 公式切片的显示缩放基准（见 PageFlow.bodyFontSize）
    bodyFontSize: analysis.bodyFontSize,
    stats: {
      sliceCount: nodes.filter((n) => n.kind === 'slice').length,
      textCount: textNodes.length,
      translatedCount: textNodes.filter((n) => n.target).length,
      bodyTextRatio: blocks.length > 0 ? Number((bodyBlocks / blocks.length).toFixed(2)) : 0,
      skippedIntervalCount,
      contentWidth,
      coveredHeight,
      droppedGapHeight,
      splitFigureCount,
      duplicatedTextArea,
      duplicatedBlockCount,
      uncoveredGraphicCount,
      partiallyCoveredGraphicCount,
    },
  };
}
