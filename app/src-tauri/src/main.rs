// 薄壳阶段：窗口承载前端，平台能力以 command 形式逐步加入（ADR-016）。

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

fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![append_log])
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
