// 薄壳阶段：窗口承载前端，平台能力以 command 形式逐步加入（ADR-016）。
// I22：LLM HTTP 通道与系统钥匙串。I23：SQLite 论文库存储底座（ADR-007）。

mod llm;
mod storage;

use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use tauri::Manager;

use storage::{Collection, PaperMeta, Store};

/// 论文库存储。惰性建库（首个命令到达时），单写 Mutex（ADR-007）。
struct LibraryStore {
    store: Store,
}

impl LibraryStore {
    fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
        app.path()
            .app_data_dir()
            .map_err(|e| format!("无法确定数据目录：{e}"))
    }
}

/// 诊断日志落盘。
///
/// ── 为什么需要它 ──
/// 打包后的桌面应用里 WebView 没有 DevTools 入口（macOS 的 WKWebView 也不认
/// `WEBKIT_INSPECTOR_SERVER`，那是 WebKitGTK 的机制），一旦前端抛错就只能看到
/// 界面上那句「解析失败」，拿不到堆栈。所以把日志写到磁盘，出问题时直接读文件。
///
/// 落点：`~/Library/Logs/TransPaper/diagnostics.log`（写不进去时退回 /tmp）。
/// 产品态路径以后统一走 `app_data_dir`（ADR-016），这里只服务诊断，保持简单。
#[tauri::command]
fn append_log(line: String) {
    let path = std::env::var("HOME")
        .map(|home| format!("{home}/Library/Logs/TransPaper/diagnostics.log"))
        .unwrap_or_else(|_| "/tmp/transpaper-diagnostics.log".to_string());

    if let Some(dir) = std::path::Path::new(&path).parent() {
        let _ = create_dir_all(dir);
    }

    let stamped = format!(
        "{} {line}\n",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    );

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(stamped.as_bytes());
    }
}

/// LLM 请求透传管道：发 POST、把 status/body/retry-after 原样交回。
/// 错误分类（401/429/5xx → 重试）在前端领域层，这里不重复实现。
#[tauri::command]
async fn llm_chat(
    url: String,
    api_key: String,
    body: String,
    timeout_ms: Option<u64>,
) -> Result<llm::LlmHttpResult, String> {
    llm::http_post_json(&url, &api_key, &body, timeout_ms.unwrap_or(60_000)).await
}

/// 钥匙串读取。没有条目返回 Ok(None) —— 这是正常状态（用户还没填过 Key）。
#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 钥匙串写入。
#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

/// 钥匙串删除（用户清空 Key 时调用；条目不存在不算错误）。
#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

const KEYCHAIN_SERVICE: &str = "com.ddmiurge.transpaper";

// ── I23 论文库 SQLite 底座 ──
// 全部命令 async：跑在 tauri 的线程池里，SQLite 操作不会卡 UI 主线程；
// Mutex 锁内无 await，不跨异步持锁。

#[tauri::command]
async fn db_list_papers(app: tauri::AppHandle, lib: tauri::State<'_, LibraryStore>) -> Result<Vec<PaperMeta>, String> {
    let dir = LibraryStore::data_dir(&app)?;
    lib.store.with(&dir, |inner| storage::list_papers(&inner.conn))
}

#[tauri::command]
async fn db_put_paper(
    app: tauri::AppHandle,
    lib: tauri::State<'_, LibraryStore>,
    meta: PaperMeta,
) -> Result<(), String> {
    let dir = LibraryStore::data_dir(&app)?;
    lib.store.with(&dir, |inner| storage::put_paper(&inner.conn, &meta))
}

#[tauri::command]
async fn db_delete_paper(
    app: tauri::AppHandle,
    lib: tauri::State<'_, LibraryStore>,
    id: String,
) -> Result<(), String> {
    let dir = LibraryStore::data_dir(&app)?;
    lib.store.with(&dir, |inner| storage::delete_paper(inner, &id))
}

#[tauri::command]
async fn db_list_collections(
    app: tauri::AppHandle,
    lib: tauri::State<'_, LibraryStore>,
) -> Result<Vec<Collection>, String> {
    let dir = LibraryStore::data_dir(&app)?;
    lib.store.with(&dir, |inner| storage::list_collections(&inner.conn))
}

#[tauri::command]
async fn db_put_collection(
    app: tauri::AppHandle,
    lib: tauri::State<'_, LibraryStore>,
    collection: Collection,
) -> Result<(), String> {
    let dir = LibraryStore::data_dir(&app)?;
    lib.store.with(&dir, |inner| storage::put_collection(&inner.conn, &collection))
}

#[tauri::command]
async fn db_delete_collection(
    app: tauri::AppHandle,
    lib: tauri::State<'_, LibraryStore>,
    id: String,
) -> Result<(), String> {
    let dir = LibraryStore::data_dir(&app)?;
    lib.store.with(&dir, |inner| storage::delete_collection(&inner.conn, &id))
}

/// PDF 二进制按 base64 过 IPC（v1 简单可靠）。
/// 优化点：`tauri::ipc::Response` 可零拷贝回传原始字节，等 profile 显示这是瓶颈再换。
#[tauri::command]
async fn db_get_file(
    app: tauri::AppHandle,
    lib: tauri::State<'_, LibraryStore>,
    id: String,
) -> Result<Option<String>, String> {
    let dir = LibraryStore::data_dir(&app)?;
    lib.store.with(&dir, |inner| {
        let path = inner.files_dir.join(format!("{id}.pdf"));
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("读取论文文件失败：{e}")),
        };
        Ok(Some(encode_base64(&bytes)))
    })
}

#[tauri::command]
async fn db_put_file(
    app: tauri::AppHandle,
    lib: tauri::State<'_, LibraryStore>,
    id: String,
    data_base64: String,
) -> Result<(), String> {
    let dir = LibraryStore::data_dir(&app)?;
    lib.store.with(&dir, |inner| {
        let bytes = decode_base64(&data_base64)?;
        let tmp = inner.files_dir.join(format!("{id}.pdf.tmp"));
        let final_path = inner.files_dir.join(format!("{id}.pdf"));
        std::fs::write(&tmp, bytes).map_err(|e| format!("写入论文文件失败：{e}"))?;
        // 先写临时文件再改名：进程被杀在写入中途不会留下半个坏 PDF
        std::fs::rename(&tmp, &final_path).map_err(|e| format!("落盘论文文件失败：{e}"))?;
        Ok(())
    })
}

/// 每次启动报告一次库路径，诊断日志能对上「到底在用哪个库文件」。
#[tauri::command]
async fn db_info(app: tauri::AppHandle) -> Result<String, String> {
    let dir = LibraryStore::data_dir(&app)?;
    Ok(dir.join("library.db").to_string_lossy().to_string())
}

// base64 手写（RFC 4648 标准字母表，带 padding）——不为两个函数引入依赖
const B64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn encode_base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(B64_TABLE[(n >> 18) as usize & 63] as char);
        out.push(B64_TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64_TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64_TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
    fn value(c: u8) -> Result<u32, String> {
        match c {
            b'A'..=b'Z' => Ok((c - b'A') as u32),
            b'a'..=b'z' => Ok((c - b'a') as u32 + 26),
            b'0'..=b'9' => Ok((c - b'0') as u32 + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("非法 base64 字符".to_string()),
        }
    }
    let bytes: Vec<u8> = s.bytes().filter(|b| !b" \n\r\t".contains(b)).collect();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        if chunk.len() < 2 {
            return Err("base64 长度不足".to_string());
        }
        let mut n = value(chunk[0])? << 18 | value(chunk[1])? << 12;
        if chunk.len() > 2 {
            n |= value(chunk[2])? << 6;
        }
        if chunk.len() > 3 {
            n |= value(chunk[3])?;
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

fn run() {
    tauri::Builder::default()
        .manage(LibraryStore { store: Store::new() })
        .invoke_handler(tauri::generate_handler![
            append_log,
            llm_chat,
            secret_get,
            secret_set,
            secret_delete,
            db_list_papers,
            db_put_paper,
            db_delete_paper,
            db_list_collections,
            db_put_collection,
            db_delete_collection,
            db_get_file,
            db_put_file,
            db_info
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

fn main() {
    run();
}

#[cfg(mobile)]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn mobile_main() {
    run();
}
