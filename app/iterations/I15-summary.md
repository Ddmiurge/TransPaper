# I15 小结 · 标题提取 + 作者免译

> 迭代日期：2026-09-26 · 样本：`fixtures/two-column-sample.pdf`（ResNet）、
> `fixtures/single-column-sample.pdf`（2608.02657）、`fixtures/acl-sample.pdf`（ACL2026）
> 触发：I14 完成后用户确认"按计划继续下一个迭代"，并追加一条明确需求——
> **"作者就不需要进行翻译了"**。

## 目标

两条工作流合并到本迭代：

1. **计划内**：I14 小结「下一迭代候选」第 1 项——标题仍取自文件名，
   应改为从 **PDF 元数据 / 首页标题**提取，让论文库里的标题是论文真正的标题。
2. **新需求（用户原话）**：作者不翻译。道理与参考文献一致——`Kaiming He` 译出来
   无法回查、也丧失指代意义；机构 / 邮箱同理，它们是标识符不是自然语言。

## 方案

### 作者免译：`src/domain/frontMatter.ts`（新文件）

**为什么用「纵向区间」而非「逐块判定」**：作者块在语料特征上与正文几乎一致
（同字号、同宽度、同断点密度），没有哪一块能独立判出来。但它和标题、摘要一起
占据首页**顶部一段连续区间**：标题（最大字号）在下界，`Abstract`/`摘要` 标题
在上界，两者之间的就是作者 / 机构 / 邮箱 / 日期。这与参考文献的「区间」思路
是同一类问题（`references.ts`），只是区间在首页顶部。

三个纯函数：

- `findTitleBlock(blocks, pageHeight)`：前 40% 页高内 `fontScale ≥ 1.3` 且最大的块；
  找不到（没有足够大的字）返回 `null` → 保守放弃标记，不误伤。
- `findFrontMatterBoundary(blocks, titleY)`：优先匹配 `Abstract`/`摘要`/`SUMMARY`
  等标题词；找不到用「首个宽比 ≥ 0.85 且 ≥ 80 字的正文块」兜底（作者块普遍偏窄
  0.5–0.8，摘要 / 引言整栏宽，区分干净）。无界返回 `Infinity`。
- `markFrontMatter(blocks, pageHeight)`：仅首页（`pageIndex === 0`）生效；
  把严格落在 `(title.y, boundaryY)` 之间的块统一标 `translatable = false`、
  `nonTranslatableReason = 'authors'`。

**关键决策**：

- **只限第 1 页**——front-matter 只可能出现在首页，非首页直接 no-op，不与
  references / formula / numeric 抢标记。
- **标题保持可译**：用户反对的是翻译"作者"，标题译出来对中文读者有用，所以标题块
  特意排除（区间严格 `< boundaryY`，标题在下界自然在外）。
- **摘要标题保持可译**：`Abstract` → `摘要` 同样有用，且正好落在边界 y 上被排除。
- **区间内所有块统一标 `authors`**：作者、机构、邮箱、日期 / 致谢都归此类，
  都不该翻译；渲染层对 `authors` 与 `references` 同样按「保留文本不翻译」处理。

`NonTranslatableReason` 增加 `'authors'`（`src/types.ts`）；pipeline 在
`markFormulas` 之后调用 `markFrontMatter`，注释说明它只动第 1 页、不会与
references/formula/numeric 冲突。

### 标题提取：`src/App.tsx`（`extractDocTitle`）

三级优先级，逐级降级：

1. **PDF 元数据** `doc.getMetadata().info.Title`（≤ 300 字，隐私模式等失败则跳过）；
2. **首页探测**：`analyzePage` 第 1 页 + `findTitleBlock` 取最大字号块（≤ 300 字）；
3. **文件名兜底**：去掉 `.pdf` 后缀。

`file` source 分支原本直接 `title: source.label.replace(/\.pdf$/i, '')`，
现改为 `const realTitle = (await extractDocTitle(doc)) ?? source.label...`。
内置样本（`?page=` 等）不受影响，仍用文件名。

## 实测依据（真实论文，DUMP_PAGE 验证）

- **ResNet（双栏）**：标题 `Deep Residual Learning…`（字 1.44）→ 作者行
  `Kaiming He…` / `Shaoqing Ren…`（字 1.20，跨两栏）→ 邮箱机构 → `Abstract`（y=334）。
  作者块落在 (154, 334) 区间，正确标 `authors`。
- **单栏样本**：标题（字 1.55）→ `Jianshuo Dong1,…`（字 1.00）→ 机构行（字 0.90）
  → `ABSTRACT`（y=318）。第二作者行字号仅 0.70 被字号判据误判成 `图像:font-size`，
  但它落在 front-matter 区间里，照样被标 `authors`（渲染成图像本来就不译）。

## 验证

- 单测：13 → **15 文件 / 162 用例**（+12：frontMatter 单元 10、frontMatter 真实
  首页 2）；
- 类型检查 0 错误 · 构建正常；
- **三基线无回归**：双栏 ResNet、单栏 42 页、ACL 17 页，`realPdf.test.ts` 全过；
- `frontMatter.real.test.ts` 直接断言：ResNet / 单栏的作者块 `nonTranslatableReason
  === 'authors'` 且 `translatable === false`、标题与 `Abstract`/`ABSTRACT` 保持可译。
- 修复：真实首页测试的 `viewport.transform` 在 typed `page` 下是 `Array<any>`、
  不能赋给 `Matrix` 六元组，与 `realPdf.test.ts` 一致把 `page` 标 `any` 解决。

## 遗留

- 标题提取优先用元数据，但很多论文元数据为空 → 退到首页探测；若首页标题被
  `findTitleBlock` 的 `TITLE_MIN_SCALE=1.3` 漏掉（某些会议模板标题仅稍大），会再
  退到文件名。该阈值是 ResNet + 单栏两个样本标定的，换模板可能需要放宽。
- 作者区间判定依赖 `Abstract`/`摘要` 等边界词；若某篇用 `Literature Cited` 类词
  当边界则无影响（那是文献区间，不是 front-matter），但极少数无摘要小标题的论文
  会退到「首个宽正文块」兜底——若作者块恰好也整栏宽，可能误吞。属低概率，待实测。
- 标题提取目前只接 `file` 源；内置样本与未来「论文库条目」打开时若想用真实标题，
  需把 `extractDocTitle` 也接到对应 source 分支。
