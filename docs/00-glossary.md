# 00 · 术语表

所有文档共用同一套词汇。**新增术语必须先加到这里**，否则不要在其他文档中使用。

## 领域核心

| 术语 | 定义 | 反例 / 易混淆点 |
|---|---|---|
| **Paper** | 一篇论文的**元数据聚合根**。含标题、作者、年份、DOI、所属集合、标签、导入状态。**不包含正文内容** | 不是 PDF 文件本身，也不是解析结果 |
| **Document** | 一篇 Paper 的**解析产物聚合根**。含页列表与块列表。与 Paper 一对一 | 与 Paper 分开建模，因为解析可以失败、可以重跑，而元数据始终存在 |
| **Page** | Document 中的一页。含页码、尺寸、缩略图引用 | — |
| **Block** | **渲染的最小单位**。从 PDF 中提取的、带坐标和类型的最小可视单元，与屏幕上某块区域一一对应 | 不等于"段落"。一个段落可能是 3 个 Block |
| **Segment** | **翻译的最小单位**。由若干 Block 按阅读顺序聚合出的语义段落 | 不等于 Block。也不等于"句子" |
| **Translation** | 某个 Segment 在特定 (provider, model, targetLang) 下的一份译文。一个 Segment 可以有**多份** Translation | 不是 Segment 的字段，是独立实体 |
| **Collection** | 用户创建的集合（文件夹），**可嵌套成树**。Paper 与 Collection 是多对多 | 区别于 Tag |
| **Tag** | 扁平标签，无层级。Paper 与 Tag 是多对多 | 区别于 Collection |
| **SmartCollection** | **保存的查询条件**，不是容器。例如"2023 年后的 GNN 论文"。成员动态计算 | 不存储成员列表 |
| **Glossary** | 用户维护的术语表，用于约束翻译译法（如 "attention" → "注意力"） | 不要与"术语表（本文档）"混淆 |

## 处理流程

| 术语 | 定义 |
|---|---|
| **阅读顺序（reading order）** | 从 PDF 排版坐标重建出的、符合人类阅读习惯的 Block 序列。双栏论文的阅读顺序是左栏从上到下、再右栏从上到下，而非按 y 坐标全局排序 |
| **段落重建（paragraph reconstruction）** | 把碎片化的文本 Block 聚合成语义 Segment 的算法过程。见 `02-domain-model.md` |
| **translatable** | Block 上的布尔标志。为假时该 Block **不进入翻译流水线**。见 `adr/ADR-004` |
| **块类型判定（block classification）** | 为每个 Block 赋予类型（正文 / 标题 / 题注 / 图片 / 表格 / 代码 / 公式 / 页眉页脚 / 参考文献）的过程 |
| **改判（override）** | 用户手动修正某个 Block 的类型或 translatable 标志。改判会触发受影响 Segment 的缓存失效 |
| **asset** | 从 PDF 中裁切出的二进制资源：页面缩略图、图表裁剪图、公式渲染缓存。存放在文件系统而非数据库 |

## 架构与运行时

| 术语 | 定义 |
|---|---|
| **覆盖式渲染（overlay rendering）** | 保留原始 PDF 版式，译文以独立文本层注入原文段落下方。**本项目的默认方案**。见 `adr/ADR-003` |
| **重排渲染（reflow rendering）** | 丢弃原版式，按 Block 顺序用 HTML 重新排版原文段与译文段。本项目作为**兜底模式**保留 |
| **限界上下文（bounded context）** | 领域边界。本项目含五个：文献库、导入解析、翻译、阅读、外部能力 |
| **端口（port）** | 领域层定义的接口（如 `TranslatorPort`），由基础设施层的适配器实现。这是依赖倒置的具体形式 |
| **适配器（adapter）** | 基础设施层对端口的实现，如 `LlmProviderAdapter`、`PdfExtractorAdapter` |
| **sidecar** | 由主程序启动的**独立子进程**，用于隔离易崩溃或需要异构运行时的任务。本项目用于 Python 版面分析 |
| **Provider** | 外部翻译能力的抽象，如 OpenAI 兼容接口、DeepL、本地 Ollama。切换 Provider 不影响领域逻辑 |
| **sourceHash** | Segment 源文本的哈希值，作为**翻译缓存键**的组成部分。见 `adr/ADR-005` |

## 存储

| 术语 | 定义 |
|---|---|
| **AssetStore** | 文件系统上的二进制资源存储目录，采用**内容寻址**（以内容哈希命名） |
| **写队列（write queue）** | SQLite 是单写者模型，所有写操作必须经此队列串行化。见 `adr/ADR-007` |
| **WAL** | Write-Ahead Logging。SQLite 的日志模式，允许"多读单写"并发 |
| **FTS5** | SQLite 的全文检索扩展。本项目的侧边栏搜索依赖它 |

## 状态机

| 术语 | 适用对象 | 取值 |
|---|---|---|
| **ingestionStatus** | Paper | `Pending` / `Running` / `Done` / `Failed` / `Degraded` |
| **Segment.status** | Segment | `Pending` / `Running` / `Done` / `Failed` |

> `Degraded` 表示解析仅完成部分能力（例如降级为纯文本模式，丢失了表格结构）。见 `03-data-flows.md` 的失败降级路径。
