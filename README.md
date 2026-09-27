# TransPaper · 论文阅读翻译器

本地优先的论文阅读桌面应用：**导入 PDF、建库管理、一键翻译成中英对照**。
公式、图表、表格、参考文献保持原样，不被翻译、不被破坏。

> 技术栈：Tauri 2（Rust 壳）+ React + TypeScript + pdf.js · 数据存 SQLite + 系统钥匙串 · 全程本地，翻译请求直发你选择的服务商

## 功能

**阅读**
- 打开 PDF（按钮 / 全窗拖放），重排为单栏中英对照文档流，正文可选中、可搜索
- 双栏 / 单栏排版自动识别；跨页段落自动接续为一个翻译单元
- 公式（行间 / 行内）、矢量与位图图表、文字表格整体保留为原图切片；行内公式以占位符送译、译后原样回填——公式字符不经过模型
- 参考文献区自动识别，不翻译、按文献表排版呈现；标题 / 作者 / 机构免译
- 判定有误？右键任意段落手动改判（图表 / 表格 / 公式 / 文献 / 正文），入库论文持久化

**论文库**
- 侧边栏管理：集合归类、标签、搜索（标题 + 标签）、改名；论文与阅读进度持久化
- 数据存本机 `app_data_dir`（SQLite + PDF 文件），不依赖任何云

**翻译**
- 逐段异步翻译：并发池、失败重试（指数退避 + 尊重 Retry-After）、可取消、译文缓存
- 逐段回填（译完一段显示一段）、进度与失败明细、无 Key 的预览模式（占位译文看排版）
- 缓存按原文 + 提示词版本索引——换文档不串味，改提示词自动失效

## 支持的翻译服务

任意 OpenAI 兼容接口，内置预设（应用内「翻译设置」切换）：

| 服务 | 模型 | 说明 |
|---|---|---|
| DeepSeek | `deepseek-chat` | 默认 |
| Kimi（月之暗面） | `moonshot-v1-8k` | |
| 通义千问 | `qwen-plus` | |
| MiMo（小米） | `mimo-v2.6-pro` | 按量付费 Key 为 `sk-` 开头；Token Plan 订阅 Key（`tp-`）需把接口地址改为 `https://token-plan-cn.xiaomimimo.com/v1` |
| 本地 / 自建 | — | Ollama 等，`http://127.0.0.1:11434/v1` |

API Key 存储在 **macOS 系统钥匙串**（桌面版），不写入文件或网页存储。

## 安装使用

当前仅提供 macOS（Apple Silicon）构建，未经公证：

1. 从源码构建（见下节），或直接获得他人构建的 `TransPaper.app`
2. 拷入 `/Applications`
3. **首次打开**：由于未经 Apple 公证，Gatekeeper 会提示「无法验证开发者」——
   右键点击应用选「打开」，或到 系统设置 → 隐私与安全性 点「仍要打开」，一次即可
4. 翻译设置里填入任一服务的 API Key 即可开始

## 从源码构建

依赖：Node 22+、Rust 工具链（rustup）、Xcode Command Line Tools。

```bash
cd app
npm install

# 浏览器开发模式（翻译走 Vite 代理）
npm run dev

# 桌面开发模式
npm run tauri:dev

# 全量测试（239 前端用例 + Rust 测试）
npm test
cargo test          # 在 app/src-tauri/ 下

# 构建桌面应用并安装到 /Applications
npm run tauri:build
bash scripts/install-app.sh
```

push / PR 会自动跑 CI（tsc → vitest → 三份真实 PDF 基线回归 → cargo test）。

## 文档

| 位置 | 内容 |
|---|---|
| [`docs/`](docs/README.md) | 架构文档集：领域模型、数据流、存储设计、技术选型、路线图 |
| [`docs/adr/`](docs/adr) | 18 份架构决策记录（ADR）——**每条决策的“为什么”在这里** |
| [`app/TASK.md`](app/TASK.md) | 26 个迭代（I0–I25）的任务清单与演进史 |
| [`app/iterations/`](app/iterations) | 各迭代小结：做了什么、踩了什么坑 |
| [`app/DESIGN.md`](app/DESIGN.md) | I0 行走骨架设计（迭代级文档） |

## 已知限制

- 仅 macOS（Apple Silicon）构建并验证；Windows / Linux 打包未做
- 未经签名 / 公证，分发给别人需手动放行（见上）
- 扫描版 PDF（无文本层）不支持 OCR，只能以原版式查看
- 中文论文的跨页段落接续暂未实现（英文形态已覆盖）
- 100 页级论文的内存 / 性能指标未系统测量

## 路线图状态

- ✅ **M1 可行性验证**、**M2 可用产品**（桌面形态 + 三条核心需求闭环）
- 🔶 **M3 完整能力**（部分提前兑现：手动改判、公式保护、跨页接续）；
  剩余：签名公证、三平台打包、双语导出、术语表、失败单点重试

## 开发约定（贡献者必读）

- `app/src/domain/**` 是零 IO 纯函数——外部能力（像素探测、HTTP、存储）一律做成注入式端口，保证 Node 离线可测
- 架构决策先写 ADR 再动代码；改判定阈值必须用真实 PDF 数据标定并加回归断言
- 翻译提示词版本（`promptVersion`）变更会使全部缓存失效——不是 bug，是设计
