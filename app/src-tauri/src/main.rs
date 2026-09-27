// 薄壳阶段：窗口承载前端，平台能力以 command 形式逐步加入（ADR-016）。
// I22 起包含：LLM HTTP 通道（WebView fetch 过不了 CORS 且打包后无 dev 代理）
// 与系统钥匙串（API Key 不再落 localStorage，兑现 ADR-011 §5）。

mod llm;

use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;

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

fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            append_log,
            llm_chat,
            secret_get,
            secret_set,
            secret_delete
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
