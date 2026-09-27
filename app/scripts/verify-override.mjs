/**
 * 块类型手动改判端到端验证（I18）
 *
 * 真实 DOM 驱动：入库 → 右键段落 → 菜单选「按图表保留」→ 断言段落从文本流消失
 * → 整页刷新 → 断言改判从 IndexedDB 恢复（该段仍不在文本流里）。
 * 改判的持久化与应用只有真实浏览器能验证。
 *
 * 用法：先 `npm run dev`，再 `node scripts/verify-override.mjs`
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const BASE = 'http://localhost:5173/';
const PORT = 9335;
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

async function waitUntil(cdp, expression, timeoutMs = 20000, label = '') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
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
      '--user-data-dir=/tmp/edge-override-profile',
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

    await cdp.send('Page.navigate', { url: BASE });
    console.log('[step] navigated, waiting for sidebar');
    await waitUntil(cdp, "document.querySelector('.library')", 20000, '侧边栏');

    // ── 1. 入库（经真实文件输入），等瀑布流出文本段落 ──
    const { root } = await cdp.send('DOM.getDocument');
    const fileInput = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: "input[type=file]" });
    await cdp.send('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [FIXTURE] });
    await waitUntil(cdp, "document.querySelectorAll('.flow-source').length > 5", 30000, '文本段落渲染');
    const countBefore = await cdp.evaluate(`document.querySelectorAll('.flow-source').length`);
    console.log(`[1] 入库成功，可选中段落 ${countBefore}`);

    // ── 2. 选一个正文段落（长、非免译），记下它的文本指纹 ──
    const picked = await cdp.evaluate(`(() => {
      const els = [...document.querySelectorAll('.flow-source')];
      const el = els.find((e) => !e.classList.contains('is-untranslated') && (e.textContent || '').length > 120);
      if (!el) return null;
      const article = el.closest('[data-block-id]');
      if (!article) return null;
      return { blockId: article.dataset.blockId, fingerprint: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) };
    })()`);
    if (!picked) throw new Error('没找到可改判的正文段落');
    console.log(`[2] 目标段落 blockId=${picked.blockId} text="${picked.fingerprint}…"`);
    // 用文本指纹（而非 blockId）做跨刷新断言 —— 改判重析后块序号可能位移
    const fp = JSON.stringify(picked.fingerprint);
    const existsExpr = `[...document.querySelectorAll('.flow-source')].some(e => (e.textContent||'').replace(/\\s+/g,' ').trim().startsWith(${fp}))`;

    // ── 3. 右键 → 菜单 → 选「按图表保留」──
    await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-block-id="${picked.blockId}"]');
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 300 }));
    })()`);
    await waitUntil(cdp, "document.querySelector('.override-menu')", 8000, '改判菜单');
    console.log('[3] 右键菜单已弹出');
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.override-menu button')]
        .find((b) => b.textContent.includes('按图表保留'));
      if (!btn) throw new Error('菜单里没有「按图表保留」');
      btn.click();
    })()`);
    // 该块从文本流消失（变为图像切片区间）
    await waitUntil(cdp, `!(${existsExpr})`, 10000, '段落移出文本流');
    await waitUntil(cdp, "!document.querySelector('.override-menu')", 5000, '菜单关闭');
    console.log('[3] 改判生效：目标段落已从文本流消失');

    // ── 4. 整页刷新 → 改判必须从 IndexedDB 恢复并重新套用 ──
    await cdp.send('Page.navigate', { url: BASE });
    await waitUntil(cdp, "document.querySelectorAll('.flow-source').length > 5", 30000, '刷新后渲染');
    await sleep(1000); // 等瀑布流前几页全部就绪
    const survived = await cdp.evaluate(`!(${existsExpr})`);
    if (!survived) throw new Error('刷新后改判丢失 —— 持久化或重新套用失败');
    console.log('[4] 刷新后改判仍然生效（IndexedDB 恢复 + 重新套用）✓');

    console.log('\n全部通过 ✔');
  } finally {
    cdp?.close();
    edge.kill();
  }
}

main().catch((e) => {
  console.error('验证失败:', e.message);
  process.exit(1);
});
