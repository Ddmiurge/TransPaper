/**
 * 翻译全链路的浏览器验证。
 *
 * ── 验证什么 ──
 * 单元测试（`src/domain/__tests__/translation.test.ts`）用一个假 Provider 覆盖了
 * 调度逻辑；但下面这些只有真的跑在浏览器里才能确认：
 *   1. 真实 fetch 经 Vite 代理发出去了（CORS 代理配置是否正确）
 *   2. 请求体组装是否被服务端接受（system/user 消息、model 字段）
 *   3. 译文是否**逐段回填**到文档流里（每段完成即出现，不是等全部跑完）
 *   4. 重复点击是否命中缓存（这是缓存真正产生价值的地方）
 *   5. 失败项的报错是否传到了界面上
 *
 * 配合 `scripts/mock-llm.mjs` 使用，无需 API Key：
 *   node scripts/mock-llm.mjs 8787 &
 *   LLM_PROXY_TARGET=http://127.0.0.1:8787 npx vite &
 *   node scripts/verify-translation.mjs
 *
 * 用法：node scripts/verify-translation.mjs [url] [apiKey] [并发]
 *
 * ⚠️ **2026-09-24 起，无头 Edge 的 CDP 路径在本机失效**：
 * 连上 DevTools 目标后立刻 `WebSocket code 1006`，且进程静默退出。
 * 既有的 `browser-verify.mjs`（I0–I7 一直可用）也出现同样症状 —— 属环境变化。
 * 因此**这个脚本当前跑不出结果**，留作其他环境可用，以及作为 CDP 用法的参考。
 * 验证重心已转到 Node 侧：`src/infra/__tests__/translationIntegration.test.ts`
 * 与 `src/state/__tests__/translationStore.test.ts`（真实 HTTP，覆盖 UI 之下的全部接线）。
 *
 * 若要恢复浏览器验证：优先用 `agent-browser` skill，不要继续维护这里的 CDP 代码。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const URL_TO_OPEN = process.argv[2] ?? 'http://127.0.0.1:5173/';
const API_KEY = process.argv[3] ?? 'sk-mock-for-local-verification';
const CONCURRENCY = Number(process.argv[4] ?? 4);
const PORT = 9334;
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../artifacts');

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
    const cdp = new Cdp(ws);
    // 对端关闭时要说出来。否则表现为「await 永远不返回」，
    // 而 Node 在没有任何待处理句柄时会直接退出 —— 看起来像脚本凭空消失
    ws.onclose = (ev) => console.error(`[ws] 已关闭 code=${ev.code} reason=${ev.reason}`);
    ws.onerror = (ev) => console.error(`[ws] 出错 ${ev.message ?? ''}`);
    return cdp;
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
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
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
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  throw new Error('DevTools 端点未就绪，Edge 可能未成功启动');
}

/**
 * 等导航真正完成。
 *
 * 不能只 `sleep` 一个固定时长就往下走：此时页面可能仍是 about:blank，
 * 而 about:blank 是**不透明源**，访问 localStorage 会抛 SecurityError
 * （报错信息是 "Access is denied for this document"，看不出真正原因）。
 */
async function waitForLoad(cdp, expectedPrefix) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const state = await cdp.evaluate(
        `({ href: location.href, ready: document.readyState })`
      );
      if (state.ready === 'complete' && String(state.href).startsWith(expectedPrefix)) return state;
    } catch {
      /* 导航中求值可能失败，继续等 */
    }
    await sleep(300);
  }
  throw new Error(`等待页面加载超时：${expectedPrefix}`);
}

/** 页面内的状态快照 */
const SNAPSHOT = `(() => {
  const statusEl = document.querySelector('[data-testid="translate-status"]');
  const targets = [...document.querySelectorAll('.flow-target')];
  const sources = [...document.querySelectorAll('.flow-source')];
  const startBtn = document.querySelector('[data-testid="translate-start"]');
  const errorsEl = document.querySelector('.translate-errors');
  return {
    statusText: statusEl ? statusEl.innerText.replace(/\\n/g, ' | ') : null,
    startLabel: startBtn ? startBtn.innerText : null,
    startDisabled: startBtn ? startBtn.disabled : null,
    sourceCount: sources.length,
    targetCount: targets.length,
    /** 前 3 段译文的开头，用来确认「是内容而不是占位」 */
    sampleTargets: targets.slice(0, 3).map((el) => el.textContent.slice(0, 34)),
    /** 前 2 段原文对照，用于人工核对是否一一对应 */
    sampleSources: sources.slice(0, 2).map((el) => el.textContent.slice(0, 34)),
    errorsText: errorsEl ? errorsEl.innerText.replace(/\\n/g, ' | ').slice(0, 200) : null,
    progressPct: (() => {
      const fill = document.querySelector('.progress-fill');
      return fill ? fill.style.width : null;
    })(),
  };
})()`;

async function main() {
  // 打点只在 VERBOSE=1 时输出。定位「卡在哪一步」时需要它，
  // 平时不该混进验收输出
  const trace = (msg) => {
    if (process.env.VERBOSE) console.log(`[trace] ${msg} @${Date.now() % 100000}`);
  };
  trace('main 开始');
  mkdirSync(OUT_DIR, { recursive: true });

  // 保活：Node 的全局 WebSocket 基于 undici，**不保证**自身把事件循环撑住。
  // 如果某个 await 的间隙里没有别的待处理句柄，进程会以 0 退出、且不打印任何东西 ——
  // 这种「凭空消失」极难定位，所以这里显式挂一个计时器。
  const keepAlive = setInterval(() => {}, 1000);

  // 参数与 `browser-verify.mjs` 保持一致 —— 那份能稳定工作，差异会踩坑：
  //   `{ stdio: 'ignore' }`：默认的 pipe 模式下，Edge 的管道无人抽干，
  //   实测会导致刚连上的 DevTools 目标立刻异常关闭（WebSocket code 1006），
  //   表现为「脚本连上就静默退出」，极难定位。
  //   `--no-default-browser-check` / `--disable-extensions`：避免首次运行的弹窗与扩展干扰。
  const edge = spawn(
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
      '--no-default-browser-check',
      '--disable-extensions',
      `--remote-debugging-port=${PORT}`,
      '--user-data-dir=/tmp/edge-translation-profile',
      '--window-size=1280,1600',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  edge.on('error', (e) => console.error('Edge 启动失败', e));

  trace('Edge 已 spawn，等 DevTools 端点');
  const cdp = await (async () => {
    const target = await waitForDevtools();
    trace(`DevTools 就绪: ${target.url}`);
    return Cdp.connect(target.webSocketDebuggerUrl);
  })();
  trace('CDP 已连接');

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // ── 1. 先写入设置。必须在加载页面之前 —— 设置的读取发生在模块初始化时 ──
    await cdp.send('Page.navigate', { url: URL_TO_OPEN });
    trace('已发起导航，等待加载完成');
    await waitForLoad(cdp, URL_TO_OPEN.split('?')[0]);
    trace('加载完成，准备写设置');
    await sleep(800);
    await cdp.evaluate(`(() => {
      const settings = {
        provider: 'deepseek',
        baseUrl: '/api/llm',
        apiKey: ${JSON.stringify(API_KEY)},
        model: 'deepseek-chat',
        concurrency: ${CONCURRENCY},
        maxAttempts: 3,
        baseDelayMs: 800,
        // 关掉预览占位译文，否则分不清看到的是真译文还是占位内容
        previewMode: false,
      };
      localStorage.setItem('paper-reader:translation-settings', JSON.stringify(settings));
      // 缓存也清掉，保证这一轮真的是在发请求
      localStorage.removeItem('paper-reader:translation:__index');
      return true;
    })()`);

    // 重新加载，让设置生效
    await cdp.send('Page.navigate', { url: URL_TO_OPEN });
    await waitForLoad(cdp, URL_TO_OPEN.split('?')[0]);
    await sleep(600);

    // ── 2. 等文档流渲染出可选中段落 ──
    let rendered = 0;
    for (let i = 0; i < 60; i += 1) {
      rendered = await cdp.evaluate(`document.querySelectorAll('.flow-source').length`);
      if (rendered > 0) break;
      await sleep(500);
    }
    trace(`渲染轮询结束，段落数=${rendered}`);
    if (rendered === 0) throw new Error('等待渲染超时：没有出现可选中段落');
    console.log(`页面已渲染：${rendered} 个段落`);

    const before = await cdp.evaluate(SNAPSHOT);
    console.log(`\n【翻译前】`);
    console.log(`  按钮: ${before.startLabel}（disabled=${before.startDisabled}）`);
    console.log(`  状态区: ${before.statusText}`);
    console.log(`  段落 ${before.sourceCount} | 译文 ${before.targetCount}`);

    // ── 3. 点击一键翻译 ──
    const clicked = await cdp.evaluate(`(() => {
      const btn = document.querySelector('[data-testid="translate-start"]');
      if (!btn) return 'no-button';
      if (btn.disabled) return 'disabled';
      btn.click();
      return 'ok';
    })()`);
    console.log(`\n点击「一键翻译」→ ${clicked}`);
    if (clicked !== 'ok') throw new Error(`无法点击翻译按钮：${clicked}`);

    // ── 4. 轮询，同时记录「译文何时开始出现」以验证逐段回填 ──
    let firstTargetAt = null;
    let midSnapshot = null;
    const startedAt = Date.now();
    let last = null;
    for (let i = 0; i < 160; i += 1) {
      await sleep(500);
      last = await cdp.evaluate(SNAPSHOT);

      if (firstTargetAt === null && last.targetCount > 0) {
        firstTargetAt = Date.now() - startedAt;
      }
      // 抓一张「跑了一半」的快照，用来证明不是跑完才一起出现
      if (!midSnapshot && last.targetCount > 0 && /翻译中/.test(last.startLabel ?? '')) {
        midSnapshot = last;
      }
      if (last.startDisabled === false && /完成|失败|取消/.test(last.statusText ?? '')) break;
    }

    console.log(`\n【翻译后】`);
    console.log(`  按钮: ${last.startLabel}`);
    console.log(`  状态区: ${last.statusText}`);
    console.log(`  段落 ${last.sourceCount} | 译文 ${last.targetCount}`);
    if (last.errorsText) console.log(`  错误区: ${last.errorsText}`);

    if (firstTargetAt !== null) {
      console.log(`\n  逐段回填：第一段译文在点击后 ${firstTargetAt}ms 就出现了`);
    } else {
      console.log(`\n  ⚠ 逐段回填未观察到 —— 译文始终没有出现`);
    }
    if (midSnapshot) {
      console.log(
        `  运行中快照：已完成 ${midSnapshot.targetCount} 段时进度条为 ${midSnapshot.progressPct}（说明是增量回填）`
      );
    }

    console.log(`\n  译文样例:`);
    for (const t of last.sampleTargets) console.log(`    ${t}…`);
    console.log(`  对应原文:`);
    for (const s of last.sampleSources) console.log(`    ${s}…`);

    // ── 5. 再点一次，验证缓存命中 ──
    await cdp.evaluate(`(() => {
      const btn = document.querySelector('[data-testid="translate-start"]');
      btn.click();
      return true;
    })()`);
    await sleep(2500);
    const after = await cdp.evaluate(SNAPSHOT);
    console.log(`\n【第二次点击（验证缓存）】`);
    console.log(`  状态区: ${after.statusText}`);

    // ── 6. 截图 ──
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(resolve(OUT_DIR, 'translation-check.png'), Buffer.from(shot.data, 'base64'));
    writeFileSync(
      resolve(OUT_DIR, 'translation-check.json'),
      JSON.stringify({ before, mid: midSnapshot, after: last, secondClick: after }, null, 2),
      'utf-8'
    );
    console.log(`\n产物：artifacts/translation-check.png / .json`);

    // ── 7. 结论 ──
    const ok = last.targetCount > 0 && last.errorsText === null;
    console.log(`\n结论：${ok ? '✅ 翻译链路打通' : '⚠ 见上方明细'}`);
    if (!ok && last.errorsText) {
      console.log('  提示：错误里出现 "Failed to fetch" 多半是代理没配好，');
      console.log('        400/401 则是 Key 或模型名的问题。');
    }
  } finally {
    clearInterval(keepAlive);
    cdp.close();
    edge.kill('SIGKILL');
  }
}

main().catch((err) => {
  console.error('验证失败：', err.message);
  process.exit(1);
});
