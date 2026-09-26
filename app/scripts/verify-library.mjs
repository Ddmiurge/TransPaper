/**
 * 论文库「集合 + 标签」端到端验证（I14）
 *
 * 为什么单独写一个脚本：browser-verify.mjs 只测渲染质量，不碰侧边栏的
 * 集合/标签交互。这里用真实 DOM 驱动：入库 → 建集合 → 归属 → 打标签 →
 * 按集合过滤 → 刷新后持久化。IndexedDB 的持久化只有真实浏览器能验证。
 *
 * 用法：先 `npm run dev`，再 `node scripts/verify-library.mjs`
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const BASE = 'http://localhost:5173/';
const PORT = 9334;
const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/two-column-sample.pdf');

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
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面内求值失败: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value;
  }
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

async function waitForDevtools() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch { /* not up yet */ }
    await sleep(400);
  }
  throw new Error('DevTools 端点未就绪');
}

/** 轮询直到 expression 求值为真（或超时） */
async function waitUntil(cdp, expression, timeoutMs = 20000, label = '') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // 强制转布尔 —— 直接返回 DOM 节点会触发 returnByValue 的循环引用错误
    const ok = await cdp.evaluate(`(() => { try { return !!(${expression}); } catch { return false; } })()`);
    if (ok) return true;
    await sleep(300);
  }
  throw new Error(`等待超时: ${label || expression}`);
}

async function main() {
  if (!existsSync(FIXTURE)) throw new Error(`找不到 fixture: ${FIXTURE}`);

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-gpu',
      '--no-proxy-server',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--remote-debugging-port=${PORT}`,
      '--user-data-dir=/tmp/edge-lib-profile',
      '--window-size=1500,2400',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let cdp;
  try {
    const target = await waitForDevtools();
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');

    await cdp.send('Page.navigate', { url: BASE });
    console.log('[step] navigated, waiting for sidebar');
    await waitUntil(cdp, "document.querySelector('.library')", 20000, '侧边栏');

    // ── 1. 入库：用 fixture PDF 经真实文件输入 ──
    console.log('[step] getting document root');
    const { root } = await cdp.send('DOM.getDocument');
    console.log('[step] root nodeId =', root?.nodeId);
    const fileInput = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: "input[type=file]" });
    if (!fileInput?.nodeId) throw new Error('找不到文件输入');
    await cdp.send('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [FIXTURE] });
    await waitUntil(cdp, "document.querySelector('.library-item')", 20000, '论文入库');
    const title = await cdp.evaluate(`document.querySelector('.library-item-title')?.textContent ?? ''`);
    console.log(`[1] 入库成功，条目: ${title}`);

    // ── 2. 新建集合 ──
    await cdp.evaluate(`(() => {
      const inp = document.querySelector('.library-newcoll-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '深度学习');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.evaluate(`document.querySelector('.library-newcoll-btn').click()`);
    await waitUntil(
      cdp,
      "[...document.querySelectorAll('.library-nav-label')].some(e => e.textContent === '深度学习')",
      10000,
      '集合出现在导航'
    );
    console.log('[2] 新建集合「深度学习」成功');

    // ── 3. 打开分配菜单 → 勾选集合 + 加标签 ──
    const diag = await cdp.evaluate(`({
      items: document.querySelectorAll('.library-item').length,
      menus: document.querySelectorAll('.library-item-menu').length,
      listUl: document.querySelectorAll('.library-list').length,
      count: document.querySelector('.library-count')?.textContent ?? '',
      empty: document.querySelector('.library-empty')?.textContent ?? '',
      navs: [...document.querySelectorAll('.library-nav-label')].map(e => e.textContent)
    })`);
    console.log('[3-diag]', JSON.stringify(diag));
    await cdp.evaluate(`document.querySelector('.library-item-menu').click()`);
    await waitUntil(cdp, "document.querySelector('.library-menu')", 8000, '分配菜单');
    // 勾选第一个集合复选框
    await cdp.evaluate(`(() => {
      const chk = document.querySelector('.library-menu-chk input');
      if (chk && !chk.checked) chk.click();
    })()`);
    // 加标签「精读」
    await cdp.evaluate(`(() => {
      const inp = document.querySelector('.library-menu-taginput');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '精读');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const form = inp.closest('form');
      form.requestSubmit();
    })()`);
    await waitUntil(
      cdp,
      "[...document.querySelectorAll('.library-tag')].some(e => e.textContent === '精读')",
      10000,
      '标签出现'
    );
    const tags = await cdp.evaluate(`[...document.querySelectorAll('.library-tag')].map(e => e.textContent)`);
    const inColl = await cdp.evaluate(`(() => {
      const chk = document.querySelector('.library-menu-chk input');
      return chk ? chk.checked : false;
    })()`);
    console.log(`[3] 归属集合=${inColl} 标签=${JSON.stringify(tags)}`);
    if (!inColl) throw new Error('集合未勾选上');
    if (!tags.includes('精读')) throw new Error('标签未加上');
    // 关掉菜单
    await cdp.evaluate(`document.querySelector('.library-item-menu').click()`);

    // ── 4. 按集合过滤：点导航里的「深度学习」──
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.library-nav-item')].find(b => b.querySelector('.library-nav-label')?.textContent === '深度学习');
      btn.click();
    })()`);
    await sleep(400);
    const visibleInColl = await cdp.evaluate(`document.querySelectorAll('.library-item').length`);
    console.log(`[4] 切到「深度学习」后可见条目数=${visibleInColl}`);
    if (visibleInColl !== 1) throw new Error('集合过滤失败：应只剩 1 条');

    // ── 5. 刷新后仍持久化（IndexedDB）──
    await cdp.send('Page.navigate', { url: BASE });
    await waitUntil(cdp, "document.querySelector('.library-item')", 20000, '刷新后重新渲染');
    const persistedColl = await cdp.evaluate(`[...document.querySelectorAll('.library-nav-label')].some(e => e.textContent === '深度学习')`);
    const persistedTag = await cdp.evaluate(`[...document.querySelectorAll('.library-tag')].some(e => e.textContent === '精读')`);
    console.log(`[5] 刷新后 集合持久化=${persistedColl} 标签持久化=${persistedTag}`);
    if (!persistedColl || !persistedTag) throw new Error('刷新后未持久化');

    // 切回「全部」拿到完整视图再截图
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.library-nav-item')].find(b => b.querySelector('.library-nav-label')?.textContent === '全部');
      if (btn) btn.click();
    })()`);
    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const fs = await import('node:fs');
    fs.writeFileSync('/tmp/i14-sidebar.png', Buffer.from(shot.data, 'base64'));
    console.log('[shot] 截图已存 /tmp/i14-sidebar.png');

    console.log('\n✅ I14 论文库集合/标签 端到端验证通过');
  } finally {
    cdp?.close();
    edge.kill('SIGKILL');
  }
}

main().catch((e) => {
  console.error('验证失败:', e.message, e.stack ?? '');
  process.exitCode = 1;
});
