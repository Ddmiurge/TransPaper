# I22 小结 · 桌面翻译链路（Rust HTTP 通道 + 系统钥匙串）

> 状态：**已完成** · 2026-09-27 · 前置：I21 桌面薄壳（ADR-016）

## 问题：桌面上翻译是坏的

开发时翻译依赖 Vite dev server 的 `/api/llm` 代理（绕 CORS），打包后这个代理不存在——
请求会打到 `tauri://localhost/api/llm` 直接 404。也就是说 I21 的 .app 能看论文，但**一点翻译就失败**。
这是 ADR-011 早就预告的迁移项（「迁 Tauri 后由 Rust 侧发起请求」），本迭代兑现。

## 改动

### 1. Rust HTTP 通道（`src-tauri/src/llm.rs` + `llm_chat` command）

- reqwest POST（JSON + Bearer），**只做透明管道**：把 `status + body + retry-after` 原样交回前端，
  错误分类（401/429/5xx → 重试行为）仍在前端领域层——同一规则不写两份。
- 超时由 reqwest 负责；坑：reqwest 的 Display 把超时细节吞成 "error sending request"，
  **必须用 `is_timeout()` 判断后规范化消息**（"request timed out"），前端靠短语区分超时与断网。
- 单元测试 3 项：状态码/响应体透传、Retry-After 换算（`Retry-After: 2` → 2000ms）、超时不挂死
  （mock 用 `std::net::TcpListener` 手写，不引测试框架）。

### 2. 传输层抽象（`src/infra/llmTransport.ts`）

- `LlmTransport` 接口 + 两个实现：`fetchTransport`（浏览器，经 Vite 代理）/ `tauriTransport`（桌面）。
- `OpenAICompatibleTranslator` 增加 `transport` 参数，缺省按环境自动选择——
  **领域行为零改动**，既有的 mock-llm 集成测试原样通过。
- 桌面通道的两个边界：
  - 相对路径 baseUrl（`/api/llm`）在桌面必然 404 → 提前报可理解的错误；
  - 用户取消只**放弃等待**，Rust 侧请求跑完丢弃（不写缓存）。要省这笔钱将来再加按 id 取消。
- 过程中抓到一个真 bug：`invoke` 原来写在 abort 检查**之前**——已取消的请求仍然发出去了。单测锁死。

### 3. Key 存系统钥匙串（ADR-011 §5 欠账兑现）

- Rust：`secret_get/set/delete`（keyring crate，service = `com.ddmiurge.transpaper`）；
  无条目返回 Ok(None)，删不存在的条目不算错。
- 前端 `translationSettings.ts` 按环境分流：
  - **桌面**：Key 只进钥匙串；localStorage 里的设置**不再含 Key**；
    800ms 防抖写入（输入框逐字符 onChange，钥匙串不能每字符写一次）；
    启动时 `hydrateApiKey()` 异步取回（只在当前无 Key 时写入，避免与用户输入互踩）。
  - **浏览器**：行为完全不变（Key 仍在 localStorage）。
- 桌面默认 baseUrl 是 `https://api.deepseek.com`；localStorage 里旧存的 `/api/llm` 会被强制纠正
  （桌面上它必然 404）；切换服务预设时自动填入该服务的完整地址。

## 验证

| 层 | 结果 |
|---|---|
| Rust 单元测试 | 3/3（透传 / Retry-After / 超时） |
| 前端新单测 | 10/10（通道分流、参数组装、abort 不发请求、钥匙串防抖与恢复） |
| 全量回归 | **23 文件 / 215 用例全绿**（含 mock-llm 集成测试，证明 fetch 路径无回归） |
| Web e2e | verify-override.mjs 全过（改判流程无回归） |
| release 包 | tauri build 通过 |

**未自动化的一环**：真机 UI 点翻译到真实 Key 的端到端——需要真实 Key（用户决定放到接近成品时校准）。
链路每一环（HTTP 层、参数组装、错误分类、调度重试）都已各自被测试覆盖。

## 下一步（桌面化第三步，ADR-016 已排）

`app_data_dir` + SQLite（docs/04 DDL + FTS5 全文检索）→ 三平台 CI → 签名/公证。
