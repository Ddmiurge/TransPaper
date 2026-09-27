/**
 * 桌面包诊断：启动 app 若干秒后退出，再把落盘日志读出来。
 *
 * 用法：
 *   node scripts/desktop-diagnose.mjs [运行时长秒数]
 *
 * ── 为什么不用 CDP ──
 * macOS 的 WKWebView 不认 `WEBKIT_INSPECTOR_SERVER`（那是 WebKitGTK 的机制），
 * 打包后的 app 也没有 DevTools 入口。所以改成让前端把关键步骤与异常写进
 * 日志文件（见 src/infra/desktopLog.ts + src-tauri/src/main.rs），跑完读文件。
 *
 * 前提：`npx tauri build --debug`（Inspector 与日志都需要 debug 构建）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';

const APP =
  '/Users/huangqixu/WorkBuddy/论文阅读软件/app/src-tauri/target/debug/bundle/macos/TransPaper.app/Contents/MacOS/paper-reader';
const LOG = `${homedir()}/Library/Logs/TransPaper/diagnostics.log`;
const SECONDS = Number(process.argv[2] ?? 15);

if (!existsSync(APP)) throw new Error(`找不到 debug 构建的可执行文件: ${APP}\n请先跑: npx tauri build --debug`);

// 每次都从干净的日志开始 —— 否则会把上一次的残留混进结论
rmSync(LOG, { force: true });

const child = spawn(APP, [], { stdio: ['ignore', 'pipe', 'pipe'] });
let rustLog = '';
child.stdout.on('data', (d) => (rustLog += d.toString()));
child.stderr.on('data', (d) => (rustLog += d.toString()));

const timer = setTimeout(() => child.kill('SIGKILL'), SECONDS * 1000);
// Node 的全局 WebSocket 不撑事件循环；这里是纯定时器，用 unref 也无害
timer.unref?.();

child.on('exit', () => {
  console.log(`===== 运行 ${SECONDS}s 后的诊断日志 =====`);
  if (!existsSync(LOG)) {
    console.log('（没有产生日志 —— 前端可能根本没起来）');
  } else {
    console.log(readFileSync(LOG, 'utf8'));
  }
  console.log('===== Rust 侧输出 =====');
  console.log(rustLog.trim() || '（无）');
});
