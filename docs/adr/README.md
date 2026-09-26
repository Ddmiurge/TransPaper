# 架构决策记录（ADR）索引

**每个决策的 WHY 在这里，不在正文。** 阅读正文时若对某个设计产生"为什么这样做"的疑问，先在这里找。

## 状态含义

| 状态 | 含义 |
|---|---|
| `Proposed` | 提议中，尚未生效 |
| `Accepted` | **已接受。实现时必须遵循** |
| `Deprecated` | 已废弃，不再适用 |
| `Superseded by ADR-XXX` | 被新决策取代，新决策生效 |

## 索引

| 编号 | 决策 | 状态 | 关联需求 |
|---|---|---|---|
| [ADR-001](ADR-001-local-first-modular-monolith.md) | 采用本地优先的模块化单体，不做服务端 | Accepted | 全部 |
| [ADR-002](ADR-002-block-segment-dual-model.md) | 采用 Block / Segment 双层模型，分表存储 | Accepted | R1、R3 |
| [ADR-003](ADR-003-overlay-parallel-rendering.md) | 采用覆盖式对照渲染为主，重排模式兜底 | **Superseded by ADR-008** | R3 |
| [ADR-004](ADR-004-nontext-blocks-not-translated.md) | 非文本块默认不翻译，且允许用户手动改判 | Accepted | R3 |
| [ADR-005](ADR-005-async-translation-segment-cache.md) | 翻译异步任务化 + 段落级缓存 | Accepted | R3 |
| [ADR-006](ADR-006-parser-sidecar-isolation.md) | 解析器采用独立子进程隔离 | Accepted | R1 |
| [ADR-007](ADR-007-sqlite-as-primary-store.md) | 采用 SQLite 作为主存储 | Accepted | R1、R2 |
| [ADR-008](ADR-008-reflow-as-primary-rendering.md) | 重排式为默认且唯一的对照渲染模式 | Accepted | R3 |
| [ADR-009](ADR-009-vector-path-figure-detection.md) | 图形区域检测基于 PDF 矢量路径 | Accepted | R3 |
| [ADR-010](ADR-010-reflow-typography-rules.md) | 重排输出的排版规则（无框、限行宽、首行缩进、保留粗斜体） | Accepted | R3 |
| [ADR-011](ADR-011-translation-pipeline-shape.md) | 翻译流水线的实现形态（逐段请求、缓存键、CORS 代理、Key 存放） | Accepted | R3 |
| [ADR-012](ADR-012-references-and-translatable-flag.md) | 参考文献不翻译；`translatable` 与 `isBodyText` 分离 | Accepted | R3 |
| [ADR-013](ADR-013-formulas-as-image-slices.md) | 行间公式按图像切片渲染、不翻译；行内上下标用 span 级 script 还原 | Accepted | R3 |
| [ADR-014](ADR-014-wrapped-figures-and-region-remark.md) | 绕排图形障碍；区域内正文重标记；正文字号二次修正 | Accepted | R3 |

## 依赖关系

```
ADR-001（模块化单体）
  ├─ ADR-006（sidecar 隔离）—— 单体的重活隔离手段
  └─ ADR-007（SQLite）—— 单体的本地存储

ADR-002（Block/Segment 双层）
  ├─ ADR-003（覆盖式渲染，已被 ADR-008 取代）—— 依赖 Block 的坐标
  ├─ ADR-004（非文本块不译）—— 依赖 Block 的类型系统
  └─ ADR-008（重排式渲染）—— 取代 ADR-003 的主次关系
        ├─ ADR-009（图形区域检测）—— 重排式的前置依赖
        ├─ ADR-010（排版规则）—— 重排式的呈现细则
        ├─ ADR-011（翻译流水线形态）—— 兑现 ADR-005 的落地细节
        └─ ADR-012（参考文献不翻译）—— 延伸 ADR-004 的「不翻译」边界

ADR-005（异步翻译）—— 依赖 ADR-002 的 Segment 作为任务粒度
```

## 新建 ADR 的规则

- 编号连续，不复用已废弃编号
- 一个 ADR 只记录**一个**决策
- 必须包含 `Context`（为什么需要做决定）与 `Consequences`（放弃了什么）
- 决策被推翻时**不修改原 ADR**，而是新建一个 ADR 并将原 ADR 状态改为 `Superseded by ADR-XXX`
