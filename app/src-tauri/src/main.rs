// 薄壳阶段：窗口只承载前端，平台能力逐步以 command 形式加入（ADR-016）。
// 目前不注册任何 command —— 加入第一个 command 时要同步更新 capabilities。

fn run() {
    tauri::Builder::default()
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
