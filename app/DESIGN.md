# I0 迭代设计 · 行走骨架（Walking Skeleton）

> **这是迭代级文档，不是项目级文档。** 每个迭代结束时重写。项目的架构决策在 `../docs/`，本文件不重复。

## 1. 迭代目标

**一句话**：打开一篇双栏 PDF，在每段原文下方看到一段译文（内容可以是假的），并且缩放时译文跟着走。

## 2. 为什么要做这个迭代

I0 是**验证型迭代**，目标不是产出功能，而是回答一个问题：

> **「译文能否精确注入到原文段落下方」这件事，技术上成立吗？**

这个问题的答案决定 `docs/adr/ADR-003`（覆盖式对照渲染）是否成立。如果不成立，后续四个迭代的排法要重做，但代价只有几天——而不是在写完解析器、翻译层、UI 之后才发现。

**我在这个迭代里最担心的三件事**（按可能性排序）：

1. **坐标映射有系统性偏差**。`pdf.js` 的 viewport 坐标 → CSS 像素，中间涉及 PDF 的 y-up 到屏幕 y-down 翻转、字体高度近似、缩放变换。任何一环算错，译文就会整体偏移。
2. **栏检测的简单启发式不够用**。通栏标题会污染 x 投影，导致栏缝漏检。
3. **译文长度不可控**。中文译文比英文原文长，撑开后可能压住下一段。I0 先接受重叠，只验证位置是否准确。

## 3. 范围

### ✅ 本迭代做

| 项 | 说明 |
|---|---|
| pdf.js 渲染 | canvas 渲染 + 缩放 |
| 文本项提取 | `getTextContent()` → 带 viewport 坐标的 BBox |
| 栏检测（最简版） | x 轴投影找栏缝，剔除宽元素干扰 |
| 行聚合 | 相同基线的文本项合并成行 |
| 段落聚合（`ParagraphBuilder` v0） | 行间距判定切段，参数先拍脑袋 |
| 覆盖式渲染 | 段落下方注入译文 div |
| 调试层 | 显示 Block bbox、栏缝、段落边界 |
| 自检 | 输出越栏块数、重叠块数、bbox 包含率 |

### ❌ 本迭代明确不做

- **不接真实翻译**——译文用 `mock/translations.ts` 里的硬编码文本。接真实模型是 I2
- **不做持久化**——刷新页面就重来。落库是 I5
- **不做块类型判定**——所有块都当正文处理。表格/代码/图片的识别是 I4
- **不做文件选择 UI**——直接从 `fixtures/` 加载固定 PDF
- **不做侧边栏**——I3
- **不做 Tauri**——I3 之后
- **不做三栏 / 无栏**——只保证双栏
- **不做跨页段落**——只在单页内聚合
- **不做译文折叠/浮层模式**——只做撑开，且接受重叠

> 这份"不做"清单和"做"清单同等重要。范围蔓延是单人项目最常见的死法。

## 4. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 构建 | Vite | HMR 毫秒级，I0 的核心工作是反复调坐标 |
| 框架 | React + TypeScript | 后续迁移到 Tauri 时原样保留 |
| PDF 渲染 | `pdfjs-dist` | 唯一现实选择；其文本层算法可参考 |
| 状态管理 | React `useState` | I0 的状态极少，不引入额外库 |
| UI 库 | 不引入 | I0 不需要好看 |
| 测试 | Vitest（仅 `ParagraphBuilder`） | 纯函数，测试成本极低 |

**版本锁定**：安装时用最新稳定版，`package-lock.json` 提交。不使用 `^` 之外的浮动范围。

## 5. 数据模型

对齐 `../docs/02-domain-model.md`，但去掉 DB 相关字段与类型系统（那是 I4/I5）。

```ts
// src/types.ts

/** viewport 坐标系：原点在页面左上角，y 向下，单位 CSS 像素 */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** pdf.js 的原始文本项（只保留我们用到的字段） */
export interface PdfTextItem {
  str: string;
  transform: number[];   // [a, b, c, d, e, f]
  width: number;         // 文本空间
  height: number;        // 文本空间
  fontName: string;
}

/** 归一化后的文本项 */
export interface TextItem {
  id: string;
  str: string;
  bbox: BBox;
  baselineY: number;
  fontSize: number;
  fontName: string;
}

/** 一行：相同基线的文本项 */
export interface TextLine {
  itemIds: string[];
  text: string;
  bbox: BBox;
  baselineY: number;
}

/** 块：本迭代中所有块都是正文段落 */
export interface Block {
  id: string;
  pageIndex: number;
  columnIndex: number;
  readOrder: number;
  bbox: BBox;
  lineIds: string[];
  text: string;
}

/** 翻译单元：本迭代与 Block 一一对应（真实的 N:1 聚合在 I1 完善） */
export interface Segment {
  id: string;
  pageIndex: number;
  columnIndex: number;
  readOrder: number;
  blockIds: string[];
  bbox: BBox;
  text: string;
  translation: string | null;
}
```

> **注意**：I0 中 Segment 与 Block 是 1:1 的。`docs/02` 设计的 N:1 聚合（多个 Block 合成一段）在双栏论文上其实很常见，但 I0 先不做，避免一次引入两个变量。

## 6. 关键算法

### 6.1 坐标映射

```ts
function toBBox(item: PdfTextItem, viewport: PageViewport): BBox {
  const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const fontHeight = Math.hypot(tx[2], tx[3]);
  const width = item.width * viewport.scale;
  const height = (item.height || fontHeight) * viewport.scale;
  return {
    x: tx[4],
    y: tx[5] - height,   // tx[5] 是基线，减去高度得到上缘
    width,
    height,
  };
}
```

**这是本次迭代最需要盯的地方。** `viewport.transform` 已完成 y 轴翻转，所以结果直接是屏幕坐标。实际字体高度与 `item.height` 的关系需要靠调试层目视校正——这是已知的调参点，不是 bug。

### 6.2 栏检测（最简版）

```
输入：一页的所有 TextItem
输出：栏缝的 x 坐标列表

1. 剔除"宽元素"：bbox.width > 页面宽度 × 0.6 的 item 不参与投影
   （通栏标题、跨栏图表会污染投影，导致栏缝漏检）
2. 把页面横向切成 4px 一个桶，标记被文本覆盖的桶
3. 扫描连续未覆盖的区间，保留满足以下条件的：
   - 宽度 ≥ 18px
   - 位于页面内部（距左右边缘均 > 页面宽度 × 15%）
4. 取这些区间的中心 x 作为栏缝
```

**局限（本迭代接受）**：无法处理三栏、无法处理栏内的大面积空白（如公式居中留白）。这些在 I1 用更强的版面分析解决。

### 6.3 行聚合

```
1. 同一栏内，按 baselineY 升序排序
2. 若两个 item 的 |baselineY 差| < 中位字号 × 0.5，视为同一行
3. 行内按 x 升序拼接文本（处理词间空格）
```

### 6.4 段落聚合（`ParagraphBuilder` v0）

```ts
export interface ParagraphBuildOptions {
  /** 行距超过中位行高的多少倍，判定为段落边界 */
  paragraphGapRatio: number;   // 默认 0.6（I0 拍脑袋值，I1 用黄金数据集标定）
}

export function buildParagraphs(
  lines: TextLine[],
  options?: Partial<ParagraphBuildOptions>
): Block[];
```

```
1. 输入已按 reading order 排好序的行
2. 逐行比较：gap = nextLine.y - (curLine.y + curLine.height)
3. gap > 中位行高 × paragraphGapRatio → 断开，开启新段落
4. 段落的 bbox = 其所有行 bbox 的并集
```

### 6.5 阅读顺序

```
1. 按栏缝把 item 分到各栏（左→右）
2. 栏内按行聚合、再按段落聚合
3. readOrder = 栏序号 × 10000 + 段序号
4. 宽元素（跨栏）单独处理：按 y 坐标插入到对应位置（I0 粗略处理）
```

### 6.6 译文注入

```tsx
<div className="pdf-container" style={{ position: 'relative' }}>
  <canvas ref={canvasRef} />
  <div className="overlay" style={{ position: 'absolute', inset: 0 }}>
    {segments.map(seg => (
      <div
        key={seg.id}
        data-segment={seg.id}
        style={{
          position: 'absolute',
          left: seg.bbox.x,
          top: seg.bbox.y + seg.bbox.height + GAP,
          width: seg.bbox.width,
        }}
      >
        {seg.translation}
      </div>
    ))}
  </div>
</div>
```

`GAP` 默认 2px。译文背景用半透明色，方便看出重叠。

## 7. 验收标准

| # | 标准 | 验证方式 | 门槛 |
|---|---|---|---|
| A1 | 双栏 PDF 正常渲染并分页 | 目视 | 必须 |
| A2 | Block bbox 框对文字 | 调试层叠加 bbox 边框，人工检查 30 个块 | ≥ 90% 框对 |
| A3 | 段落顺序正确（左栏读到底再读右栏） | 目视 + 打印 readOrder 序列 | 栏内正确率 ≥ 95% |
| A4 | 译文注入在原文段下方 | 目视 | 不压住下一段的**原文**（压住译文可接受） |
| A5 | 缩放 100% / 150% / 200% 下 A2-A4 结论不变 | 逐档目视 | 必须 |
| A6 | 自动化自检无异常 | 点"自检"按钮输出统计 | 越栏块 = 0，bbox 包含率 = 100% |

**自检指标定义**：

- **越栏块数**：Block 的 x 范围超出了其被分配的栏边界的数量。应为 0
- **bbox 包含率**：Block 内所有 TextItem 的 bbox 被 Block bbox 包含的比例。应为 100%
- **重叠块数**：译文区与下一 Segment 的原文 bbox 有重叠的数量。允许 > 0（记下来，I1 处理）

## 8. 风险与应对

| 风险 | 可能性 | 应对 |
|---|---|---|
| 坐标映射整体偏移 | 中 | 调试层显示 bbox 边框，先用一页纯文字校验 |
| 栏缝漏检（通栏标题干扰） | 高 | 剔除宽元素后再投影；仍失败则手动指定栏缝，先跑通 |
| 段落切分过碎 / 过整 | 高 | I0 不追求质量，只要求"看起来是段"；参数标定放 I1 |
| 译文撑开压住下一段 | 高 | I0 接受；I1/I2 做折叠与浮层模式 |
| pdf.js worker 配置踩坑 | 中 | Vite 下用 `?url` 导入 worker |
| 双栏 PDF 首页有跨栏摘要 | 高 | 首页单独容忍，从第 2 页开始验收 |

## 9. 与架构文档的对应

| 本迭代产物 | 对应 `../docs/` |
|---|---|
| `types.ts` 的 `BBox` / `TextItem` / `Block` / `Segment` | `02-domain-model.md` §3（简化版，去掉 DB 字段） |
| `toBBox()` | `02` §3.1 的 bbox 定义 |
| `detectColumns()` | `03-data-flows.md` §1 的「版面分析」阶段 |
| `buildParagraphs()` | `02` §5 的 `ParagraphBuilder`（v0，无跨页、无多 Block 聚合） |
| 覆盖层 | `adr/ADR-003` 的覆盖式渲染方案 |
| 译文直接放在 Block 下方 | `02` §3 的"译文回填到 blockIds 最后一个 Block 下方" |

## 10. 可能需要回头改 ADR 的信号

如果出现以下情况，**停下编码，先改文档**：

| 信号 | 要改什么 |
|---|---|
| A2 的 bbox 框对率 < 70% 且调参无效 | `ADR-003` 需要重评：覆盖式渲染可能不可行 |
| 栏检测在主流双栏论文上失败率 > 30% | `ADR-006`（sidecar 隔离）需要提前到 I1 |
| 译文撑开后完全不可读 | `ADR-003` 的三种显示模式需要重排优先级 |

> 这条不是形式主义。I0 的唯一价值就是**用最低成本发现方向错了**。发现时改文档，不是为了记录，是为了让下一个迭代的起点正确。
