# 代码审查报告 · 重复实现与架构冗余

> 审查日期：2026-09-27
> 审查范围：`app/src/**`（56 个 `.ts/.tsx` 文件，11,836 行）+ `docs/**`（架构文档集，14 份 ADR）
> 审查方式：全量通读源码，交叉比对符号引用，核对代码与 ADR 状态的一致性
> **本次审查未修改任何代码。**

---

## 一、总体评价

先说好的部分，这份代码库的水准明显高于同规模原型：

- **领域层零 IO 的依赖倒置做得彻底**。`analyzePage`、`buildPageFlow`、`runTranslation` 都是纯函数 + 注入式端口（`isInsideFigure`、`hasContent`、`TranslatorPort`、`TranslationCachePort`、`LibraryDb`），因此解析算法能在 Node 里离线回归测试。这是这个项目最有价值的资产。
- **注释质量罕见地高**。几乎每个魔法数字都写了「为什么是这个值」和「实测样本是几」，例如 `baselineTolerance` 的 0.06em、`FIGURE_TEXT_MAX_FONT_RATIO` 的 0.85。这是团队记忆，不要动。
- **自检指标化**（`duplicatedTextArea`、`uncoveredGraphicCount`、`splitFigureCount`、`geometryConfidence`）把「图有没有被切碎」这类肉眼问题变成了可断言的数字，思路正确。

**主要问题**是：项目经历过一次渲染路线的根本转向（ADR-003 覆盖式 → ADR-008 重排式），**旧路线的代码没有被清理，而是与新路线并行存在**。这造成了一组真实的冗余，也埋了一份已经开始漂移的重复实现。

共识别 5 类、19 项可精简项，保守估计可移除 **约 520–600 行**（占 11,836 行的 4.5%–5%），其中约 360 行属于「已废弃但仍活着」的整块代码。

---

## 二、精简清单总览

| 编号 | 精简项 | 类别 | 优先级 | 预估行数 | 风险 |
|---|---|---|---|---|---|
| A1 | 移除「原版式 / 覆盖式」渲染路线（`viewMode='overlay'` 及其全部配套） | 废弃架构 | 🔴 | ~300 | 中（需先确认无人依赖） |
| A2 | 删除 `App.tsx` 中与 `PageFlowBlock` 重复的逐页流水线 | 重复实现 | 🔴 | ~120 | 低 |
| B1 | 统一包围盒并集为 `unionBBox`（现存 5 份实现） | 重复实现 | 🟡 | ~45 | 低 |
| B2 | 统一矩形相交 / 覆盖率计算（现存 7 处内联） | 重复实现 | 🟡 | ~60 | 低 |
| B3 | `selfCheck.columnsCovered` 改用 `columns.coveredColumnIndexes` | 重复实现 | 🟡 | ~15 | 低 |
| B4 | `App.tsx` 内联 `median` 改用 `stats.median` | 重复实现 | 💭 | ~8 | 低 |
| B5 | `mock.hashOf` 与 `translation.hashText` 合并 | 重复实现 | 💭 | ~10 | 低 |
| C1 | 删除 `useBlockTranslation` / `useBlockWarning` | 死代码 | 🟡 | ~18 | 低 |
| C2 | 删除 `pathBoxesFromOperators` 兼容 shim | 死代码 | 🟡 | ~10 | 低 |
| C3 | 删除 `stats.mean` | 死代码 | 💭 | ~4 | 低 |
| C4 | 删除 `libraryStore` 的 `renameCollection` / `setPaperTags` / `byId` | 死代码 | 🟡 | ~35 | 中（可能是待做功能） |
| C5 | 删除 `ColumnLayout.itemIdsByColumn` | 死代码 | 💭 | ~5 | 低 |
| C6 | 删除 `PageRenderResult.viewportTransform` | 死代码 | 💭 | ~3 | 低 |
| C7 | 清理两处 `void` 掉的死变量 | 死代码 | 💭 | ~6 | 低 |
| C8 | 裁剪 `SelfCheckReport` 中 6 个未被消费的字段 | 死代码 | 🟡 | ~35 | 低 |
| C9 | 裁剪 `Block.gapsPerLine` / `BlockStyle.gapCount` / `Block.figureReason` | 死代码 | 🟡 | ~20 | 中（可解释性） |
| D1 | 移除 `Segment` 类型与其 1:1 派生逻辑 | 模型冗余 | 🟡 | ~40 | 中（涉及 ADR-002） |
| D2 | 重命名 `pageFlow.ts` 内部 `Segment` 接口 | 模型冗余 | 💭 | ~12 | 低 |
| E1 | 修正 `docs/` 与实现漂移（SQLite / sidecar / Segment） | 文档漂移 | 🟡 | — | 低 |

> 优先级说明：🔴 建议优先处理（有实际维护成本或已产生 bug）；🟡 建议处理；💭 顺手清理。

---

## 三、详细发现

### A1 🔴 「原版式 / 覆盖式」渲染路线 —— ADR-003 已被 ADR-008 取代，代码仍在

**证据链**

- `docs/adr/README.md:20` 明确写着 ADR-003 状态为 **Superseded by ADR-008**。
- ADR-008 原文：「以重排式为默认**且唯一**的对照渲染模式，ADR-003 中『覆盖式为主』的定位作废。」
- 但代码中 `App.tsx:119` 仍保留 `type ViewMode = 'flow' | 'overlay'`，并在 `App.tsx:764-773` 提供切换按钮。

**受影响的代码**

| 位置 | 内容 |
|---|---|
| `App.tsx:119, 211-213, 301, 330, 349, 531, 622, 764-795, 934-953` | `viewMode` 状态机、overlay 分支、切换按钮、原版式 DOM 容器 |
| `App.tsx:620-677` | 覆盖式重叠测量 `overlayCheck`（`measured / overlapped / maxOverflowPx`…），注释自称「仅用于和 I0 对照」 |
| `App.tsx:884-899` | 诊断面板第四卡「I0 原版式对照」 |
| `components/ParallelLayer.tsx`（45 行，整文件） | ADR-003 的覆盖层，注释仍写着「这是 docs/adr/ADR-003 的核心做法」 |
| `components/DebugLayer.tsx`（65 行，整文件） | 坐标校验层，只在 overlay 模式挂载 |
| `pdf/pdfjsAdapter.ts:65-85` | `renderPageToCanvas` 仅被 overlay 路径调用（App.tsx:546） |
| `App.tsx:31` | `OVERLAY_GAP` |

**为什么该删**

1. 它维护的是一条已被判死的路线。ADR-008 的验收结论是「覆盖式在物理上不成立」——段间空隙 6–13px，中文译文要 3–5 行，canvas 是固定图像，没有任何办法把后面的内容推开。留着它不会让它重新变可行。
2. `overlayCheck` 测出来的 `overlapped` 数字恒为正（这是 ADR-008 的立论依据），它作为「指标」已经完成历史使命，现在只是每帧做一次无意义的 DOM 测量。
3. 删除后 `App.tsx` 从 958 行降到约 700 行，主组件的复杂度大幅下降——它现在同时承担了瀑布流编排、overlay 单页流水线、诊断面板、拖放、论文库恢复五件事。

**保留的建议**

- `DebugLayer` 如果只是「开发期坐标校验」，建议改为 `?debug=1` 下挂到瀑布流的某一页上，而不是随 overlay 一起删除——它在调 bbox 判据时确实有用。若确认不再需要，随 A1 一并删。
- 若确实需要保留「原版式查看」能力（扫描版 PDF 场景，见 `App.tsx:853-857` 的提示文案），建议**降级**为：flow 模式下无文本层的页面直接显示整页 canvas，不引入 `viewMode` 状态机。

---

### A2 🔴 `App.tsx` 与 `PageFlowBlock.tsx` 的逐页流水线重复实现

这是本次审查中**最有实际危害**的一项，因为两份实现**已经开始漂移**。

**重复对照**

| 步骤 | `PageFlowBlock.tsx`（重排视图，在用） | `App.tsx`（overlay 视图） |
|---|---|---|
| 渲染离屏画布 | `:113` | `:542` |
| 提取文本项 | `:116` | `:549` |
| 提取矢量路径 | `:119` | `:553` |
| **提取位图框** | `:122` `extractImageBoxes` | ❌ **缺失** |
| 墨迹可信度探测 | `:128-139` | `:562-573` |
| 可信度阈值 | `:24` `GEOMETRY_CONFIDENCE_FLOOR = 0.5` | `:575` 硬编码 `0.5` |
| 图形路径筛选 | `:148-152` | `:577` |
| 调用 `analyzePage` | `:154-170` | `:579-591` |
| 表格矩形并入切片几何 | `:176` | `:599`（只做了 `tableRegions`，缺 `rawImages`） |
| 译文合并（预览模式） | `:237-249` | `:404-413` |

**常量重复**

| 常量 | 位置 A | 位置 B |
|---|---|---|
| `EMPTY_TRANSLATIONS` | `App.tsx:74` | `PageFlowBlock.tsx:16` |
| `FIGURE_MAX_DISTANCE = 3` | `App.tsx:108` | `PageFlowBlock.tsx:30` |
| `PATH_PROBE_PAD = 3` | `App.tsx:561`（函数内局部） | `PageFlowBlock.tsx:27` |

**为什么是 🔴**

`App.tsx` 的版本没有传 `rawImages`（I13 位图图表检测）。也就是说：**在 overlay 视图下打开 ACL 排版的论文，图表检测是失效的**。这不是「两份一样的重复」，而是「一份旧副本没人同步」。继续保留，下次有人改 `PageFlowBlock` 的图形检测时，大概率不会想起还要同步 `App.tsx` 那份。

**建议**

随 A1 一起处理：删除 overlay 路线后，这份重复自然消失。若因故保留 overlay，则必须抽出 `usePageAnalysis(doc, pageNumber, scale, referencesActive)` 自定义 Hook，两处共用。

---

### B1 🟡 包围盒并集存在 5 份实现

| # | 位置 | 形态 |
|---|---|---|
| 1 | `domain/stats.ts:16` `unionBBox` | 导出的公共实现（正确、健壮，处理空数组） |
| 2 | `domain/figureRegions.ts:136` `unionOf` | 私有，逻辑与 1 完全相同（未处理空数组） |
| 3 | `domain/figureRegions.ts:261-267` `merge`（`expandRegionsToText` 内闭包） | 私有，逻辑与 1 相同 |
| 4 | `domain/pipeline.ts:241-266` `mergeOverlappingBoxes` 内的合并表达式 | 私有，内联版 |
| 5 | `domain/pageFlow.ts:446-455`（公式簇合并） | 内联版 |

**理由**：#2–#5 都是 #1 的复制。`unionOf` 与 #1 语义完全一致，直接替换即可；#3/#4/#5 是「两两合并」，可用 `unionBBox([a, b])` 表达。`mergeOverlappingBoxes`（pipeline.ts:241）本身就是一整个可复用的函数，却定义在 `analyzePage` 返回之后（注意它位于第 240 行、函数体已 `return` 之后的模块作用域），建议一并移入 `stats.ts` 或新建 `domain/bbox.ts`。

**建议**：新建 `domain/bbox.ts`，收拢 `unionBBox` / `intersectArea` / `coverageRatio` / `intersects` / `mergeOverlapping`，全项目统一引用。

---

### B2 🟡 矩形相交 / 覆盖率内联了 7 处

`domain/pageFlow.ts` 内同一段「算 w、算 h、判断是否 > 0」的代码出现了 6 次：

- `:258-270` `figureCoverage`
- `:362-369` 图形区域过滤（绕排判定）
- `:405-414` 同上，第二遍过滤（**与 362-369 是同一判据写了两遍**，一次在 `filter` 里、一次在后面的 `filter` 里）
- `:439-445` 公式簇合并
- `:730-755` `duplicatedTextArea`
- `:775-781` `splitFigureCount`

加上 `domain/figureRegions.ts:330-335` 的 `coverageOf`，共 7 处。

**理由**：这段代码的正确性是整个「图不被切碎、正文不被重复切」的核心。它散在 7 处意味着：任何一处判据调整（比如把 0.3 改成 0.35）都可能漏改另外 6 处，而症状是「某页的图又断了」——这类 bug 极难定位。

**特别提示**：`:362-369` 与 `:405-414` 是**同一判据的完全重复**，且第二遍用的是扩展后的 `m.bbox`（宽度已被并集撑开），而第一遍用的是原始 `bbox`。这两遍算出来的结果**并不相同**，第二遍实际是一个语义不同的过滤器。这很可能是无意的——建议合并为一次过滤并明确语义。

---

### B3 🟡 `columnsCovered` 与 `coveredColumnIndexes` 重复

```ts
// domain/columns.ts:141 —— 返回栏序号数组
export function coveredColumnIndexes(box, boundaries): number[]

// domain/selfCheck.ts:53 —— 返回栏数计数
function columnsCovered(block, boundaries): number
```

两者判据逐行一致（`left < boundaries[k+1] && right > boundaries[k]`），只是一个返回数组、一个返回计数。而 `columns.ts` 的注释里明确写了这个判据的来历（「早期版本用宽度比，把居中标题误判成越栏」）——`selfCheck.ts` 里的那份**没有这段注释**，未来有人改判据时会漏掉它。

**建议**：`selfCheck` 改为 `coveredColumnIndexes(block.bbox, boundaries).length`。

---

### B4 💭 `App.tsx` 内联 `median` 与 `stats.median` 重复

`App.tsx:663-668` 定义了一份局部 `median`，`domain/stats.ts:3` 已有导出版本，两者实现逐行相同。`App.tsx` 已 import 了 `domain/selfCheck`，没有理由不再用一下 `stats`。

---

### B5 💭 两份 FNV-1a 哈希

- `domain/translation.ts:97` `hashText`：64 位 BigInt 版，输出 16 位十六进制
- `mock/translations.ts:35` `hashOf`：32 位 `Math.imul` 版

两者算法同源但实现独立。mock 那份只需要「同原文得同占位译文」的稳定性，不需要密码学强度，可以复用 `hashText` 后取模。

---

### C1–C9 死代码

| 编号 | 位置 | 说明 |
|---|---|---|
| C1 | `state/translationStore.ts:381-394` | `useBlockTranslation` / `useBlockWarning` 全项目无调用方（已排除测试）。`warnings` 只经 `useTranslationsFor` + `useTranslation` 消费 |
| C2 | `pdf/operatorPaths.ts:171-177` | `pathBoxesFromOperators` 注释写「兼容旧调用方」，但旧调用方已不存在（生产只用 `geometryBoxesFromOperators`）。它仅被自己的测试引用，等于「测试在为 shim 辩护」 |
| C3 | `domain/stats.ts:10` | `mean` 无调用方 |
| C4 | `library/libraryStore.ts:169-179, 221-227, 142-144` | `renameCollection` / `setPaperTags` / `byId` 仅有测试引用，UI 无入口。注意：这三项可能是「待做功能」（MEMORY 里记着「集合改名 UI 未做」），删除前请确认是否近期要做 |
| C5 | `domain/columns.ts:57, 166, 178, 181` | `ColumnLayout.itemIdsByColumn` 被构造、被填充、被返回，无人读取 |
| C6 | `pdf/pdfjsAdapter.ts:16, 151` | `PageRenderResult.viewportTransform` 注释说「供调试层换算坐标」，但 `DebugLayer` 用的是 `block.bbox`，从不读它 |
| C7 | `paragraphBuilder.ts:382, 421`；`libraryStore.ts:251, 256` | `const medianLineFontSize = ...` 后跟 `void medianLineFontSize;`；`const rest = ...` 后跟 `void rest;`。两处都是「计算了但没用，用 void 抑制 lint」 |
| C8 | `domain/selfCheck.ts:19-42` | `itemsPerColumn` / `spanningBlocks` / `medianGapRatio` / `tightBlocks` / `readingOrderMonotonic` / `medianLineHeight` 六个字段计算后无消费者。`App.tsx:808-822` 只用了 `itemCount` / `lineCount` / `blockCount` / `columnCount` / `outOfColumnBlocks` / `lineOverlapCount` |
| C9 | `types.ts:159, 189`；`textStyle.ts:45, 47` | `Block.gapsPerLine` 全程只写不读（`pipeline.ts:147` 写入后无人消费）；`BlockStyle.gapCount` 同理；`Block.figureReason` 也只写不读——它的注释说「用于调试展示与后续手动改判」，但当前 UI 不展示它 |

**关于 C9 的保留意见**：`figureReason` 的注释明确说它是为「块类型手动改判」预留的。若该功能在计划内，建议保留字段但把它接进诊断面板，否则它就只是「每页几百次无意义的字符串赋值」。`gapsPerLine` 的注释自己承认「实测已证否，保留纯为诊断」——既然诊断面板也没显示它，建议直接删。

---

### D1 🟡 `Segment` 模型是空壳

`ADR-002` 设计了 Block / Segment 双层模型，其中 Segment 是「翻译单元」，支持 N 个 Block 聚合成一个 Segment。但实现状态是：

```ts
// domain/pipeline.ts:268-277
const segments: Segment[] = blocks.map((block) => ({
  id: `seg-${block.id}`,
  pageIndex: block.pageIndex,     // ← 直接复制
  columnIndex: block.columnIndex, // ← 直接复制
  readOrder: block.readOrder,     // ← 直接复制
  blockIds: [block.id],           // ← 永远只有一个元素
  bbox: block.bbox,               // ← 直接复制
  text: block.text,               // ← 直接复制
  translation: null,              // ← 永远是 null
}));
```

`translation` 字段**永远为 null**——真正的译文在 `App.tsx:426-432` 处从 `translations` Map 现填：

```ts
const segments: Segment[] = useMemo(() => {
  return analysis.segments.map((s) => ({
    ...s,
    translation: translations.get(s.blockIds[0]) ?? null,  // ← 只取 [0]
  }));
}, [analysis, translations]);
```

**问题**

1. Segment 的所有字段都来自 Block，没有任何独立信息。它是一个纯派生结构，却被写进了 `PageAnalysis` 返回类型、被 App 复制了一份、被 `ParallelLayer` 消费。
2. `blockIds: string[]` 是数组类型，但恒为单元素。这个数组签名在暗示「支持 N:1」，而实现不支持——**类型在说谎**，未来有人看到数组会以为可以直接塞多个 blockId。
3. 翻译流水线（`translationStore.register`）实际是直接注册 `blockId`，完全绕过了 Segment。也就是说 **ADR-002 的 Segment 粒度在翻译侧也没有兑现**。

**建议**：删除 `types.ts:196-205` 的 `Segment` 与 `pipeline.ts:268-277`，让 `PageFlowBlock` 和 `ParallelLayer` 直接用 `Block` + `translations` Map。若 N:1 聚合确实要做，那是一个独立迭代，届时再引入——**现在留着空壳不会让它更容易实现，只会让读代码的人误判当前能力**。

**注意**：这会触及 ADR-002（状态 Accepted）。建议先写一份 ADR-015 记录这个收缩，再改代码（ADR 规则明确要求「不修改原 ADR，新建 ADR 并将其标为 Superseded」）。

---

### D2 💭 `pageFlow.ts` 内部 `Segment` 与 `types.ts` 的 `Segment` 重名

```ts
// domain/pageFlow.ts:148-159
type SegmentKind = 'image' | 'text' | 'skip';
interface Segment { kind: SegmentKind; y0: number; y1: number; ... }
```

这是「纵向区间」，与 `types.ts` 的「翻译单元」语义完全不同，却同名。虽然 `pageFlow.ts` 没有 import 后者所以不冲突，但读代码时极易混淆。建议改名为 `Band`（纵向带）或 `Interval`。

---

### E1 🟡 文档与实现的漂移

`docs/README.md` 声明「本文档集是项目的唯一架构事实来源」「实现若与文档不一致，以文档为准」。但当前存在三处实质性漂移：

| ADR | 文档规定 | 实际实现 | 状态 |
|---|---|---|---|
| ADR-007 | SQLite 作为主存储 | `library/db.ts` 用 IndexedDB | 未兑现 |
| ADR-006 | 解析器用独立子进程隔离 | `pdf/pdfjsAdapter.ts` 同进程调用 | 未兑现 |
| ADR-002 | Block / Segment 双层、分表存储 | Segment 为内存派生、无表 | 部分未兑现 |

**为什么值得处理**：`docs/` 是新人理解系统的入口。三份 Accepted ADR 描述了一个不存在的系统，会让读者对「这份文档可信吗」产生怀疑，进而忽略其中真正有效的部分（ADR-009 到 ADR-014 是与实现高度吻合的、质量很好的决策记录）。

**建议**：不必删 ADR（它们记录了决策推理，有价值），而是在 `docs/README.md` 增加一节「文档与原型当前状态的差异」，明确列出哪些 Accepted ADR 尚未在 `app/` 原型中兑现、计划何时兑现。另外 `app/DESIGN.md` 与 `docs/` 存在职责重叠，建议明确二者边界。

---

## 四、建议的执行顺序

分四批，每批独立可验证，避免一次大改：

**第一批（收益最大，风险可控）**
1. `A1` 移除 overlay 路线 → 同时消解 `A2`、`B4`
2. 跑三基线回归：`realPdf.test.ts`（`FIXTURE=` 三份样本）+ `formulaLeak.diag.test.ts` + 浏览器截图验证

**第二批（纯去重，无行为变化）**
3. `B1` + `B2` 新建 `domain/bbox.ts` 并统一引用（**注意 `pageFlow.ts` 的 `:362-369` 与 `:405-414` 需先确认语义再合并**）
4. `B3` `selfCheck` 改用 `coveredColumnIndexes`
5. 跑 `pageFlow.test.ts` / `figureRegions.test.ts` / `tables.test.ts`

**第三批（死代码清理）**
6. `C1`、`C2`、`C3`、`C5`、`C6`、`C7` 直接删
7. `C8`、`C9` 先确认诊断面板是否要展示，不展示则删
8. `C4` **先与需求方确认**「集合改名 / 标签批量编辑」是否在做

**第四批（需要决策，不必急）**
9. `D1` + `D2` Segment 收缩 → 需先写 ADR-015
10. `E1` 文档漂移说明

---

## 五、明确**不建议**动的部分

审查中以下几处初看像冗余，实际不是，列出以免误删：

| 位置 | 看着像冗余，实际是 |
|---|---|
| `pageFlow.ts` 的 `splitFigureCount` / `duplicatedTextArea` / `uncoveredGraphicCount` 三个自检 | 三者盯的是不同的失效模式（图被劈开 / 正文被重复切 / 图形像素丢失），无法合并 |
| `textStyle.ts` 的 `refineBodyFontSize` 二次计算 | 是对 `analyzeTextStyle` 的修正，注释已说明「图表页上初次算的基准不可靠」，不是重复计算 |
| `formulas.ts` 的 `markFormulas` + `absorbFormulaFragments` 两遍 | 第二遍处理的是「被拆散的公式残块」，判据与第一遍不同 |
| `references.ts` 的区间判定 与 `frontMatter.ts` 的区间判定 | 结构相似（都是纵向区间 + 免译），但边界条件与退出条件完全不同，强行抽象会引入耦合 |
| `pipeline.ts` 中「计算 figureRegions → remarkBodyBlocks → refineBodyFontSize」的顺序 | 注释明确写了顺序是关键依赖，不能重排 |
| `translationSettings.ts` 的 `loadSettings()` 与 `useTranslationSettings()` 并存 | 前者供非 React 环境（调度器）同步读，是必要的双入口 |

---

## 六、结论

这个代码库的核心架构（领域层零 IO、注入式端口、自检指标化）是健康的，**不需要重构**。

需要清理的是两类东西：

1. **一条已死的渲染路线**（A1/A2）——约 360 行，是唯一的实质性架构冗余，且已经产生了 bug（overlay 路径缺位图检测）。
2. **几何算子与死代码的堆积**（B/C 类）——约 160 行，是迭代 16 次后自然沉淀的产物，清理成本低、收益是降低后续改判据时漏改的风险。

建议优先做第一批（A1+A2），它一次性消解本次审查中最重要的两项，且能让 `App.tsx` 这个 958 行的主组件回到可维护的规模。
