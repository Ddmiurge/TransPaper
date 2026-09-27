# I21 小结 · 桌面化第一步「薄壳」（Tauri 2）

> 迭代日期：2026-09-27 · 目标平台：macOS（aarch64）
> 决策记录见 [ADR-016](../../docs/adr/ADR-016-desktop-shell-tauri-and-cross-platform.md)

## 做了什么

- **工具链**：rustup 装好（rustc/cargo **1.98.1**；本机其实已装过，只是没进 PATH）；
  Xcode 命令行工具已存在。
- **`app/src-tauri/` 骨架**：`Cargo.toml`（tauri 2）、`tauri.conf.json`、
  `src/main.rs`、`build.rs`、`capabilities/default.json`、`icons/`。
- **npm**：`@tauri-apps/cli@2`（dev）、`@tauri-apps/api@2`；脚本 `tauri:dev` / `tauri:build`。
- **不改任何领域代码**——前端整块进 Tauri 的 WebView（ADR-016 的复用约定）。
- **产物**：`src-tauri/target/release/bundle/macos/TransPaper.app`（5.16 MiB），
  前端资源随 custom-protocol 嵌入二进制。

## 踩到的三个坑（都不是产品代码问题）

1. **`capabilities/*.json` 不允许注释**：Tauri 用严格 JSON 解析，带 `//` 会
   `failed to parse JSON: expected value at line 1 column 1`。
2. **`tauri.conf.json` 同样不允许注释**（我第二次又犯了一次，cargo build 立刻抓到：
   `key must be a string at line 29`）。→ 结论：**Tauri 的两个配置文件都当纯 JSON 对待。**
3. **图标必须是 RGBA**：`icons/icon.png` 用 truecolor RGB(colortype 2) 会被拒
   （`is not RGBA`）；且 `bundle.icon` 为空时仍会去找默认路径，所以骨架阶段
   就必须有图标文件。已写 `scripts/make-placeholder-icon.mjs` 生成纯色占位图标。

另外：**DMG 打包在受限沙箱里必然失败**（需挂载 `/Volumes` 下的临时卷，被文件删除
拦截）。`tauri.conf.json` 的 targets 已改为只打 `app`；需要 dmg 时在不受限的
本地终端把 `"dmg"` 加回去即可。

## 验证

- `cargo build`（dev + release）通过；
- `npx tauri build` 产出 `.app`，`Contents/MacOS/paper-reader` 就位；
- 前端未受影响：tsc 0 错误、**21 文件 / 205 用例**全绿。

## 下一步（桌面化第二步）

- 用 Tauri 的 `app_data_dir` 落库、把 `LibraryDb` 端口换成 SQLite
  （`docs/04` 有完整 DDL + FTS5）；
- API Key 从 localStorage 移到系统钥匙串（ADR-011 §5 的安全欠账）；
- 三平台 CI 矩阵（GitHub Actions：macos / windows / ubuntu）；
- 届时 M2 性能指标（100 页 <10s、首段 <2s、内存）才能真测。
