/**
 * 桌面环境下的诊断日志。
 *
 * ── 为什么单独做一个模块 ──
 * 打包后的应用里没有 DevTools：macOS 的 WKWebView 不认 `WEBKIT_INSPECTOR_SERVER`
 * （那是 WebKitGTK 的机制），失败时界面上只剩一句「解析失败」，拿不到堆栈。
 * 所以前端把关键步骤与异常写进日志文件，由 Rust 侧落盘（见 src-tauri/src/main.rs）。
 *
 * 浏览器里（npm run dev）没有 invoke 通道，退化成 console，不影响开发体验。
 */

type TauriInternals = {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

/** 是否运行在 Tauri 的 WebView 里 —— 判断依据只有这一个，别猜 userAgent */
export function isDesktop(): boolean {
  const g = globalThis as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return typeof g.__TAURI_INTERNALS__?.invoke === 'function';
}

export function logLine(message: string): void {
  if (!isDesktop()) {
    console.log(`[diag] ${message}`);
    return;
  }
  const g = globalThis as unknown as { __TAURI_INTERNALS__: TauriInternals };
  const invoke = g.__TAURI_INTERNALS__.invoke;
  if (!invoke) return;
  // 日志是「尽力而为」：写失败不能反过来影响业务，所以吞掉异常
  void invoke('append_log', { line: message }).catch(() => {});
}

/** 把一段错误压成单行，避免多行堆栈把日志切碎 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message} | ${(err.stack ?? '').split('\n').slice(0, 4).join(' / ')}`;
  }
  return String(err);
}

/**
 * 注册全局兜底捕获。
 *
 * 只在桌面环境启用 —— 浏览器里 DevTools 什么都看得见，
 * 多一层转发只会让控制台输出重复。
 */
export function installGlobalErrorLog(): void {
  if (!isDesktop()) return;

  window.addEventListener('error', (e) => {
    logLine(`window.error: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    logLine(`unhandledrejection: ${describeError(e.reason)}`);
  });

  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    logLine(`console.error: ${args.map((a) => (a instanceof Error ? describeError(a) : String(a))).join(' ')}`);
    original(...args);
  };
}
