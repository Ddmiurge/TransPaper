# I24 小结 · 轻量 CI + 桌面安装脚本

> 状态：**已完成** · 2026-09-27 · 前置：I21–I23 桌面化三步

## 做了什么

### 1. GitHub Actions CI（`.github/workflows/ci.yml`）

每次 push 到 main / 开 PR，GitHub 服务器自动跑全套门禁（单 job 顺序）：

1. `npm ci` + `npm run build`（tsc 类型检查 + vite 构建）
2. `vitest run`（前端全量 215 用例）
3. **真实 PDF 三基线回归**（16/42/17 页，`FIXTURE=` 分别触发——默认 vitest 只跑默认 fixture，三基线必须显式跑）
4. `cargo test`（Rust 侧，含 I22 的 LLM 通道与 I23 的 SQLite 存储测试）

两个编排细节：
- **顺序强制**：`tauri::generate_context!` 宏在编译期把 `app/dist` 嵌进二进制，
  所以必须先前端构建再 cargo——顺序错了 CI 直接编译失败。
- ubuntu 上编译 Tauri 需要 apt 装 WebKit2GTK/GTK3 系统依赖（官方前置清单）。

**编排依据**：本机已把工作流里的每条命令逐一跑过（215 用例 / 三基线 / cargo test 全绿），
CI 服务器本身的行为要等首次 push 后在 GitHub Actions 页确认。

### 2. 一键安装脚本（`app/scripts/install-app.sh`）

- ad-hoc 签名（`codesign -s -`，无开发者账号时的本地构建方案，正式分发才需要公证）
- 拷贝覆盖 `/Applications/TransPaper.app`（比每次去 `target/` 深处找 .app 方便得多）
- 已实际执行验证：签名 + 安装 + `codesign --verify` 通过

## 结果

- 质量门禁从「每次迭代手动跑」变为「push 必跑、机器执行、结果公开」
- 用户日常入口变为 `/Applications/TransPaper.app`（Launchpad/Docker 可固定）

## 明确不做（本轮决策）

- **FTS5 全文检索搁置**：需要先建「解析文本入库」数据管线，当前搜标题/标签够用，
  等「几十篇论文里找一句话」的需求真实出现再做（用户拍板）
- 三平台打包矩阵：等需要分发 Windows/Linux 版时再加（CI 先跑单平台 Ubuntu）

## 下一步候选

- 真实 Key 全文校准（用户决定放到接近成品时）
- 公证（Apple Developer 账号）后的正式分发
