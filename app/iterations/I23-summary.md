# I23 小结 · SQLite 存储底座（桌面化第三步）

> 状态：**已完成** · 2026-09-27 · 前置：I21 薄壳 / I22 翻译链路 · 兑现 **ADR-007**

## 做了什么

论文库从 IndexedDB 迁到 **SQLite（元数据）+ 文件系统（PDF 二进制）**，库文件落在
`~/Library/Application Support/com.ddmiurge.transpaper/`（Tauri 的 `app_data_dir`，跨平台由框架提供）。

- **Rust 存储层**（`src-tauri/src/storage.rs` + 8 个 `db_*` command）：
  - 表：`papers`（集合/标签/改判为 JSON 列）、`collections`、按 `last_opened_at` 建索引。
    集合成员用 JSON 列而非关联表——接口是全量 upsert、过滤在前端内存做，此规模关联表只添事务。
  - **PDF 二进制不入库**（ADR-007：大 BLOB 不进 SQLite），存 `app_data_dir/paper-files/{id}.pdf`，
    写入走「临时文件 + rename」——进程被杀不会留半个坏 PDF。
  - 单写者：全部语句过同一把 `Mutex<Connection>`（锁内无 await）。
  - 删集合时 Rust 侧也剥离论文引用（与前端 libraryStore 双保险）。
- **前端**：`TauriLibraryDb implements LibraryDb`（invoke 版），libraryStore 按环境选择实现，
  业务逻辑零改动。二进制以 base64 过 IPC（+33% 体积，v1 可靠优先；`tauri::ipc::Response`
  零拷贝是标记过的优化点）。
- **一次性迁移**（`migrateLegacyIdbToSqlite`）：仅当 SQLite 为空时执行（幂等），
  逐篇搬 meta + PDF + 集合；**不删 IndexedDB 旧库**（回滚保险）；迁移函数在构造
  IdbLibraryDb 之前先检查 `indexedDB` 全局（Node 测试环境构造期 rejection 逃逸的老坑）。

## 验证

| 层 | 结果 |
|---|---|
| Rust 单测（临时目录） | 6/6：roundtrip 覆盖写、按最近打开排序、删集合剥离引用、集合 CRUD、base64 往返（Rust 侧编解码） |
| 前端全量 | 23 文件 / 215 用例全绿（libraryStore 逻辑用内存 db 测，不依赖通道） |
| **桌面包真实验证** | 旧版 IndexedDB 里的一篇论文（ACL 17 页）**自动迁移**：日志 `library migrated: 1 papers`；二次启动**不再迁移**、从 SQLite 恢复 `loadDoc ok: pages=17` 全页解析 ok；磁盘上 `library.db`(24KB) + `paper-files/*.pdf`(11MB) 落盘确认 |

**坑**：Rust 测试并行跑时共享按 pid 命名的临时目录，先跑完的 `remove_dir_all` 把别人的连接搞成
"readonly database"——每个测试必须用独立子目录。

## 下一步（I24 候选）

1. FTS5 全文检索（表已就绪：需在解析时把 blocks 文本写入库，才有可检索的全文）
2. 三平台 CI 矩阵（GitHub Actions：vitest + tsc + build + cargo test + 三基线）
3. 签名/公证 + 一键装到 /Applications 脚本
