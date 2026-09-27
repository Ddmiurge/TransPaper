# ADR-016: 桌面化 —— Tauri 2 外壳、存储迁移与跨平台策略

## Status

Accepted（2026-09-27）

## Context

原型（`app/`）到 I20 为止一直是**纯 Web 应用**（Vite + React + TS，IndexedDB 持久化）。
三条核心需求与阅读质量专项（表格、改判、行内公式）都已具备，但产品形态仍是「浏览器里
的一个页面」：没有真实窗口、离线能力依赖浏览器、全文检索缺失、API Key 存在 localStorage
（ADR-011 §5 已标记为不安全）、M2 的性能验收指标从未测量过。

`docs/06` 的 M2 定义就是「Tauri 2 应用 + 完整持久化」，`docs/05` 的「渐进式引入 Rust」
把 Rust 推迟到 M1 之后 —— 现在正是兑现 M2 的时点。

## Decision

### 1. 分两步迁移，先给可用形态

- **第一步「薄壳」**：Tauri 2 窗口直接承载现有 Web 前端，**保留 IndexedDB**。
  目标：真实桌面窗口、离线可用、文件拖放与关联。风险最低，能最快拿到可安装的 `.app`。
- **第二步「换底座」**：IndexedDB → SQLite（按 `docs/04` 的完整 DDL，含 FTS5 trigram
  全文检索）；localStorage 里的 API Key → 系统钥匙串。

### 2. 领域层与前端整块复用

`domain/**` 全是零 IO 纯函数 + 注入式端口（`isInsideFigure`、`hasContent`、
`TranslatorPort`、`TranslationCachePort`、`LibraryDb`），这一段**不改**，
直接随前端搬进 Tauri 的 WebView。迭代 20 次积累的判据与单测原样保留 ——
这也是当初坚持「领域层零 IO」的回报。

### 3. 平台相关能力全部走 Rust 命令（端口）

文件对话框、应用数据目录、钥匙串、SQLite 一律由 Rust 侧以 Tauri command 暴露，
前端只调端口。**不再有第二处平台分支**。

## 跨平台策略

是的，跨平台从架构第一天就在考虑（`docs/05` 的平台差异风险 R-11、
`docs/06` 风险登记册中「从 M2 第一周开始三平台测试」的缓解措施）。具体约定：

| 关注点 | 约定 |
|---|---|
| 领域逻辑 | 纯 TS、无平台 API；pdf.js 在 WebView 内运行，三个平台行为一致 |
| 路径 | 一律用 Tauri 的 `app_data_dir` / `app_config_dir`，禁止硬编码 `/tmp`、`~/Library` 等 |
| 存储 | SQLite 文件放应用数据目录（ADR-007 已规定「库文件不可放网盘同步」），三平台同一份 DDL |
| 密钥 | macOS Keychain / Windows Credential Manager / Linux Secret Service，统一由 `keyring` 类端口封装 |
| WebView | macOS WKWebView / Windows WebView2 / Linux WebKitGTK 差异（R-11）：CSS 与 JS 保持保守，不做平台特性探测 |
| 构建 | 本机只能产出当前平台产物；Windows / Linux 产物交给 CI 矩阵（GitHub Actions 三平台 runner） |
| sidecar | ADR-006 的子进程隔离**暂不启用** —— pdf.js 在 WebView 内已满足需求；若将来需要更重的版面分析再引入，届时打包按平台分别处理 |

**为什么先做 macOS**：一是用户主力平台，能立刻用上并给出真实反馈；二是 WKWebView
的差异面最小，先把「薄壳 → 换底座」这条链路跑通，再扩展到差异更大的
WebView2 / WebKitGTK，风险更低。

## Consequences

- 需要本机 Rust 工具链（rustup）与 Xcode 命令行工具；CI 需要三平台 runner。
- 第一步之后仍是 IndexedDB，因此 ADR-007 的 SQLite 目标**尚未兑现**；
  `docs/README.md` 的「文档与原型当前状态的差异」表会同步更新。
- M2 的性能验收（100 页解析 <10s、首段译文 <2s、内存 <150MB/500MB）在真应用里才测得准。
