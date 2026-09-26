/**
 * 通用截图工具
 *
 * 与 browser-verify.mjs 的区别：那个脚本是**验收**用的（等特定元素出现、量固定指标），
 * 这个只是**看一眼**用的 —— 打开任意 URL，等一会儿，整页截图。
 *
 * 用途：排查「重排后的结果和原版式不一致」这类问题。需要看原版式时：
 *   node scripts/screenshot.mjs "http://127.0.0.1:5173/?page=1&view=overlay" /tmp/p1-raw.png
 *
 * 用法：node scripts/screenshot.mjs <url> [输出路径] [等待毫秒] [滚动到的 y] [滚动到的 y]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const TARGET = process.argv[2] ?? 'http://127.0.0.1:5173/';
const OUT = resolve(
  process.argv[3] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../artifacts/screenshot.png')
);
const WAIT_MS = Number(process.argv[4] ?? 6000);
/** 截图前滚动到的纵向位置。瀑布流下整页很长，需要能截任意一段 */
const SCROLL_Y = Number(process.argv[5] ?? 0);
/** 截图前滚动到某个元素（选择器）。优先级高于 SCROLL_Y */
const SCROLL_SELECTOR = process.argv[6] ?? '';
const PORT = 9334;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)));
      else slot.resolve(msg.result);
    };
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('WebSocket 连接失败'));
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function fetchJson(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      // 浏览器还没起来
    }
    await sleep(250);
  }
  throw new Error(`无法连接 CDP：${url}`);
}

mkdirSync(dirname(OUT), { recursive: true });

const profile = `/tmp/edge-shot-${Date.now()}`;
const child = spawn(
  EDGE,
  [
    '--headless=new',
        // ⚠️ `--no-sandbox` 是必需的，缺了它 Edge 会**直接崩掉**。
        //
        // 本环境下 Chromium 的沙箱初始化失败（`sandbox initialization failed:
        // Operation not permitted`），随后 GPU 进程以 exit_code=6 退出，
        // 浏览器打印 `GPU process isn't usable. Goodbye.` 后整个进程消失。
        // 从脚本侧看到的现象是「DevTools 端点连不上」或「连上后 WebSocket 立刻
        // code 1006 关闭、进程静默退出」—— 极难从表象推出真因。
        //
        // 这里只加载 localhost 页面，关掉沙箱的影响可接受。
        '--no-sandbox',
        '--disable-gpu-sandbox',
    '--disable-gpu',
    '--no-proxy-server',
    '--no-first-run',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1400,1000',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

try {
  const version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`);
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);

  const { targetId } = await cdp.send('Target.createTarget', { url: TARGET });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++cdp.seq;
      cdp.pending.set(id, { resolve, reject });
      cdp.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  await send('Page.enable');
  await sleep(WAIT_MS);

  if (SCROLL_SELECTOR) {
    // 把目标元素滚到视口顶部附近。瀑布流里元素的 offsetTop 不可靠
    // （offsetParent 层层嵌套），所以用 getBoundingClientRect 反推当前滚动量。
    const info = await send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(SCROLL_SELECTOR)});
        if (!el) return 'not-found';
        const vp = document.querySelector('.viewport') || document.scrollingElement;
        const r = el.getBoundingClientRect();
        const vr = vp.getBoundingClientRect();
        vp.scrollTop += (r.top - vr.top) - 16;
        return 'scrolled-to ' + Math.round(vp.scrollTop);
      })()`,
      returnByValue: true,
    });
    console.log(' ', info?.result?.value);
    await sleep(1000);
  } else   if (SCROLL_Y > 0) {
    // 滚动容器是 `main.viewport`（它有独立的 overflow），**不是 window** ——
    // 对 window 调 scrollTo 毫无效果。这一点踩过一次，所以写在这里备查。
    await send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('.viewport') || document.scrollingElement;
        if (el) el.scrollTop = ${SCROLL_Y};
        return el ? el.scrollTop : -1;
      })()`,
    });
    // 等滚动稳定 + 可能触发的懒渲染
    await sleep(900);
  }

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });

  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`已截图: ${OUT}`);
} catch (error) {
  console.error('截图失败:', error.message);
  process.exitCode = 1;
} finally {
  child.kill('SIGKILL');
}
