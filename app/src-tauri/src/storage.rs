//! 论文库的 SQLite 存储层（I23，兑现 ADR-007）。
//!
//! ── 设计要点 ──
//! - **库文件**在 `app_data_dir/library.db`（跨平台由 Tauri 提供路径，禁止硬编码）。
//! - **PDF 二进制不入库**（ADR-007：大 BLOB 不进 SQLite），落在
//!   `app_data_dir/paper-files/{id}.pdf`；SQLite 只存元数据。
//! - **单写者**：所有语句走同一把 `Mutex<Connection>`（ADR-007 的单写约束）。
//!   锁内无 await，不会跨异步持锁。
//! - 集合成员（collectionIds）与标签存 JSON 列：接口是全量 upsert（putMeta），
//!   且列表过滤在前端内存完成（filterPapers），此规模引入关联表只增加事务数。
//! - 错误分类在前端？这里没有重试语义，错误串直接上抛由 UI 展示。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;

/// 一次打开的库：连接 + 文件目录。用 Option 做惰性初始化（首个命令到达才建库）。
pub struct Store {
    inner: Mutex<Option<StoreInner>>,
}

pub struct StoreInner {
    pub conn: Connection,
    pub files_dir: PathBuf,
}

impl Store {
    pub fn new() -> Self {
        Store {
            inner: Mutex::new(None),
        }
    }

    /// 惰性打开（或创建）库。`base` 是 app_data_dir。
    pub fn with<T>(
        &self,
        base: &PathBuf,
        f: impl FnOnce(&mut StoreInner) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            *guard = Some(StoreInner::open(base)?);
        }
        let inner = guard.as_mut().expect("刚初始化");
        f(inner)
    }
}

/// 前端 PaperMeta 的镜像（camelCase 由 serde 自动转换）。
/// overrides 的元素结构由前端定义，这里用 Value 原样存取。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperMeta {
    pub id: String,
    pub title: String,
    pub file_name: String,
    pub byte_length: u64,
    pub page_count: u32,
    pub added_at: u64,
    pub last_opened_at: u64,
    pub last_page: u32,
    pub collection_ids: Vec<String>,
    pub tags: Vec<String>,
    pub overrides: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub created_at: u64,
}

impl StoreInner {
    fn open(base: &PathBuf) -> Result<StoreInner, String> {
        std::fs::create_dir_all(base).map_err(|e| format!("创建数据目录失败：{e}"))?;
        let files_dir = base.join("paper-files");
        std::fs::create_dir_all(&files_dir).map_err(|e| format!("创建文件目录失败：{e}"))?;

        let conn = Connection::open(base.join("library.db"))
            .map_err(|e| format!("打开 library.db 失败：{e}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|e| format!("初始化 schema 失败：{e}"))?;
        Ok(StoreInner { conn, files_dir })
    }
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL,
  last_page INTEGER NOT NULL DEFAULT 1,
  collection_ids TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  overrides TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_papers_last_opened ON papers(last_opened_at DESC);
";

const PAPER_COLUMNS: &str =
    "id, title, file_name, byte_length, page_count, added_at, last_opened_at, last_page, collection_ids, tags, overrides";

fn row_to_meta(row: &rusqlite::Row) -> rusqlite::Result<PaperMeta> {
    let collection_ids: String = row.get(8)?;
    let tags: String = row.get(9)?;
    let overrides: String = row.get(10)?;
    Ok(PaperMeta {
        id: row.get(0)?,
        title: row.get(1)?,
        file_name: row.get(2)?,
        byte_length: row.get::<_, i64>(3)? as u64,
        page_count: row.get::<_, i64>(4)? as u32,
        added_at: row.get::<_, i64>(5)? as u64,
        last_opened_at: row.get::<_, i64>(6)? as u64,
        last_page: row.get::<_, i64>(7)? as u32,
        collection_ids: serde_json::from_str(&collection_ids).unwrap_or_default(),
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        overrides: serde_json::from_str(&overrides).unwrap_or(Value::Array(vec![])),
    })
}

/// 全量 upsert。putMeta 是接口契约 —— 前端把整份 meta 写回，这里照做。
pub fn put_paper(conn: &Connection, meta: &PaperMeta) -> Result<(), String> {
    conn.execute(
        "INSERT INTO papers (id, title, file_name, byte_length, page_count, added_at, last_opened_at, last_page, collection_ids, tags, overrides)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           title=?2, file_name=?3, byte_length=?4, page_count=?5, added_at=?6,
           last_opened_at=?7, last_page=?8, collection_ids=?9, tags=?10, overrides=?11",
        rusqlite::params![
            meta.id,
            meta.title,
            meta.file_name,
            meta.byte_length as i64,
            meta.page_count as i64,
            meta.added_at as i64,
            meta.last_opened_at as i64,
            meta.last_page as i64,
            serde_json::to_string(&meta.collection_ids).map_err(|e| e.to_string())?,
            serde_json::to_string(&meta.tags).map_err(|e| e.to_string())?,
            serde_json::to_string(&meta.overrides).map_err(|e| e.to_string())?,
        ],
    )
    .map_err(|e| format!("写入论文元数据失败：{e}"))?;
    Ok(())
}

pub fn list_papers(conn: &Connection) -> Result<Vec<PaperMeta>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {PAPER_COLUMNS} FROM papers ORDER BY last_opened_at DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_meta)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 删除论文 + 它的文件 + 关联数据。
pub fn delete_paper(inner: &StoreInner, id: &str) -> Result<(), String> {
    inner
        .conn
        .execute("DELETE FROM papers WHERE id = ?1", [id])
        .map_err(|e| format!("删除论文失败：{e}"))?;
    let file_path = inner.files_dir.join(format!("{id}.pdf"));
    match std::fs::remove_file(&file_path) {
        Ok(()) => {}
        // 文件本来就不存在（如迁移中断）不算失败 —— 删除要幂等
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("删除论文文件失败：{e}")),
    }
    Ok(())
}

pub fn put_collection(conn: &Connection, c: &Collection) -> Result<(), String> {
    conn.execute(
        "INSERT INTO collections (id, name, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET name=?2, created_at=?3",
        rusqlite::params![c.id, c.name, c.created_at as i64],
    )
    .map_err(|e| format!("写入集合失败：{e}"))?;
    Ok(())
}

pub fn list_collections(conn: &Connection) -> Result<Vec<Collection>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, created_at FROM collections ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Collection {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get::<_, i64>(2)? as u64,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 删除集合并剥离所有论文对它的引用（与前端 libraryStore 的行为一致，双保险）。
pub fn delete_collection(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM collections WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, collection_ids FROM papers")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for (paper_id, json) in rows {
        let mut ids: Vec<String> = serde_json::from_str(&json).unwrap_or_default();
        let before = ids.len();
        ids.retain(|x| x != id);
        if ids.len() != before {
            conn.execute(
                "UPDATE papers SET collection_ids = ?1 WHERE id = ?2",
                rusqlite::params![serde_json::to_string(&ids).unwrap_or_default(), paper_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("transpaper-test-{}-{name}", std::process::id()));
        // Connection::open 不创建中间目录，测试自己保证它存在
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_meta(id: &str) -> PaperMeta {
        PaperMeta {
            id: id.to_string(),
            title: "深度残差学习".to_string(),
            file_name: "resnet.pdf".to_string(),
            byte_length: 1234,
            page_count: 16,
            added_at: 100,
            last_opened_at: 200,
            last_page: 7,
            collection_ids: vec!["c1".into()],
            tags: vec!["精读".into()],
            overrides: serde_json::json!([{ "anchor": "0|Intro", "kind": "figure" }]),
        }
    }

    #[test]
    fn upsert_list_roundtrip() {
        let dir = temp_dir("roundtrip");
        let conn = Connection::open(dir.join("t.db")).unwrap();
        conn.execute_batch(SCHEMA).unwrap();

        put_paper(&conn, &sample_meta("p1")).unwrap();
        // 覆盖写（同 id 更新而非新增）
        let mut updated = sample_meta("p1");
        updated.last_page = 9;
        updated.title = "改名了".to_string();
        put_paper(&conn, &updated).unwrap();

        let rows = list_papers(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].last_page, 9);
        assert_eq!(rows[0].title, "改名了");
        assert_eq!(rows[0].collection_ids, vec!["c1"]);
        assert_eq!(rows[0].tags, vec!["精读"]);
        assert_eq!(rows[0].overrides[0]["kind"], "figure");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 列表按最近打开排序() {
        let dir = temp_dir("order");
        let conn = Connection::open(dir.join("t.db")).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        put_paper(&conn, &sample_meta("old")).unwrap();
        let mut newer = sample_meta("new");
        newer.last_opened_at = 999;
        put_paper(&conn, &newer).unwrap();

        let rows = list_papers(&conn).unwrap();
        assert_eq!(rows[0].id, "new");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 删除集合时剥离论文引用() {
        let dir = temp_dir("strip");
        let conn = Connection::open(dir.join("t.db")).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        put_paper(&conn, &sample_meta("p1")).unwrap();

        delete_collection(&conn, "c1").unwrap();
        let rows = list_papers(&conn).unwrap();
        assert!(rows[0].collection_ids.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
