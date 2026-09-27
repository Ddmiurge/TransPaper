/**
 * 跨页段落接续端到端验证（I25）
 *
 * 领域层判定有单测与真实 PDF 测试覆盖，这里验证的是**接线**：
 * prevTail 是否真的从页 N 串到了页 N+1、接续宿主块是否真的渲染成
 * `flow-block--continued`（无首行缩进）、且合并单元确实绕开了普通登记。
 * 这条链跨了 App → PageFlowBlock → translationStore 三层，只有真实浏览器能验证。
 *
 * 用法：先 `npm run dev`，再 `node scripts/verify-continuation.mjs`
 */
import { spawn } from 'node:child_process';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const BASE = 'http://localhost:5173/';
const PORT = 9335;

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

async function waitUntil(cdp, expression, timeoutMs = 30000, label = '') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await cdp.evaluate(`(() => { try { return !!(${expression}); } catch { return false; } })()`);
    if (ok) return true;
    await sleep(300);
  }
  throw new Error(`等待超时: ${label || expression}`);
}

async function main() {
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
      '--user-data-dir=/tmp/edge-cont-profile',
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
    console.log('[step] navigated, waiting for first page');
    await waitUntil(cdp, "document.querySelector('[data-page=\"1\"] .page-flow')", 40000, '第 1 页渲染');

    // 顺序加载：等到前 4 页都出内容（接续对在前几页就存在）
    await waitUntil(
      cdp,
      "document.querySelectorAll('[data-page=\"4\"] .page-flow').length === 1",
      60000,
      '前 4 页渲染完成'
    );
    await sleep(500);

    // ── 1. 存在接续宿主块 ──
    const continued = await cdp.evaluate(`(() => {
      const els = [...document.querySelectorAll('.flow-block--continued')];
      return els.map((el) => {
        const src = el.querySelector('.flow-source');
        const style = getComputedStyle(src);
        return {
          page: el.closest('[data-page]')?.dataset?.page,
          text: src?.textContent?.slice(0, 60) ?? '',
          indent: style.textIndent,
        };
      });
    })()`);
    console.log(`[1] 接续宿主块数量=${continued.length}`);
    console.log(JSON.stringify(continued, null, 2));
    if (continued.length === 0) throw new Error('没有任何接续宿主块 —— 判定或接线断了');

    // ── 2. 接续宿主的原文以小写/逗号/分号开头（延续段的特征）──
    for (const c of continued) {
      if (!/^[a-z,;]/.test(c.text.trim())) {
        throw new Error(`接续宿主应以延续特征开头，实际: "${c.text}"`);
      }
    }

    // ── 3. 接续宿主的首行缩进必须是 0；对照：存在缩进非 0 的普通正文段 ──
    // （第一个 .flow-block 可能是标题 —— 标题本来就无缩进，不能当对照）
    const anyIndented = await cdp.evaluate(
      `[...document.querySelectorAll('.flow-block:not(.flow-block--continued) .flow-source')]
        .some((el) => parseFloat(getComputedStyle(el).textIndent) > 0)`
    );
    const continuedIndent = continued[0].indent;
    console.log(`[3] 存在缩进非0的普通段=${anyIndented} 接续段缩进=${continuedIndent}`);
    if (parseFloat(continuedIndent) !== 0) throw new Error('接续段缩进未去掉');
    if (!anyIndented) throw new Error('普通段落缩进异常（对照失效）');

    // ── 4. 接续宿主（合并单元）有译文容器 —— 用预览模式验证排版 ──
    // 打开设置面板，确保预览模式处于勾选状态（它默认开启 —— 已勾选时不能再点，
    // 否则会把它关掉，这正是初版脚本踩的坑）
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('翻译设置'));
      if (btn) btn.click();
    })()`);
    await waitUntil(cdp, "!!document.querySelector('.settings-panel')", 8000, '设置面板');
    const toggled = await cdp.evaluate(`(() => {
      const preview = [...document.querySelectorAll('input[type=checkbox]')]
        .find(b => b.closest('label')?.textContent.includes('预览'));
      if (!preview) return 'missing';
      if (!preview.checked) preview.click();
      return preview.checked ? 'already-on' : 'turned-on';
    })()`);
    console.log(`[4] 预览模式状态=${toggled}`);
    await sleep(500);
    const hostHasTarget = await cdp.evaluate(
      `(() => {
        const host = document.querySelector('.flow-block--continued');
        return host ? !!host.querySelector('.flow-target') : false;
      })()`
    );
    console.log(`[4] 接续宿主有译文块=${hostHasTarget}`);
    if (!hostHasTarget) throw new Error('接续宿主没有译文 —— 合并单元未渲染');

    console.log('\n✅ I25 跨页段落接续 端到端验证通过');
  } finally {
    cdp?.close();
    edge.kill('SIGKILL');
  }
}

main().catch((e) => {
  console.error('验证失败:', e.message, e.stack ?? '');
  process.exitCode = 1;
});
