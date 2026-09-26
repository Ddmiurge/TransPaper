/**
 * 浏览器端渲染验证（T0.9）
 *
 * 为什么需要这个脚本：
 *   离线自检（src/pdf/__tests__/realPdf.test.ts）只能验证算法层 —— 分栏、段落、bbox。
 *   但 I0 的验收标准里有两条只能在真实 DOM 里量：
 *     A4 译文是否压住下一段的原文
 *     A5 缩放后结论是否不变
 *   这两条依赖真实字体度量与 CSS 布局，算不出来，只能量。
 *
 * 实现方式：启动无头 Edge，通过 CDP 打开页面、轮询等待渲染完成、取出测量结果并截图。
 * 不用 --virtual-time-budget —— Vite 的 HMR WebSocket 会让虚拟时间永远走不完，实测会挂死。
 *
 * 用法：node scripts/browser-verify.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const BASE = process.argv[2] ?? 'http://127.0.0.1:5173/';
const PAGE = process.argv[3] ?? null;
const URL_TO_OPEN = PAGE ? `${BASE}${BASE.includes('?') ? '&' : '?'}page=${PAGE}` : BASE;
const PORT = 9333;
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

const MEASURE = `(() => {
  const median = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const flow = document.querySelector('.page-flow');
  const sources = [...document.querySelectorAll('.flow-source')];
  const targets = [...document.querySelectorAll('.flow-target')];
  const slices = [...document.querySelectorAll('.flow-slice')];

  const panelTexts = [...document.querySelectorAll('.report-card ul')].map((ul) => [...ul.children].map((li) => li.textContent).join(' | '));

  return {
    flowWidth: flow ? flow.offsetWidth : null,
    contentHeight: flow ? flow.scrollHeight : null,
    sourceCount: sources.length,
    targetCount: targets.length,
    sliceCount: slices.length,
    emptySlices: slices.filter((c) => c.offsetWidth < 1 || c.offsetHeight < 1).length,
    /**
     * 尺寸正常但像素全白的切片数 —— 「切了但没画上」。
     *
     * 与 emptySlices 的区别：那个只看 CSS 尺寸，抓不到「drawImage 的源区域取错，
     * 画出来是一张白纸」这类情形。只有读像素才能发现 ——
     * 否则图表会静默地变成一块空白，而且看起来「什么都没出错」。
     */
    blankSlices: slices.filter((c) => {
      if (typeof c.getContext !== 'function') return false;
      const ctx = c.getContext('2d');
      if (!ctx || !c.width || !c.height) return true;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      // 每 16 像素采样一格，够用且不必扫全图
      for (let i = 0; i < d.length; i += 64) {
        if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) {
          ink += 1;
          if (ink > 12) return false;
        }
      }
      return true;
    }).length,
    medianSourceFontSize: Math.round(median(sources.map((el) => parseFloat(getComputedStyle(el).fontSize)))),
    medianSourceHeight: Math.round(median(sources.map((el) => el.offsetHeight))),
    /** 页面上可选中的纯文本字符数 —— 这是「真重排」与「截图拼接」的分水岭 */
    selectableChars: sources.reduce((n, el) => n + el.textContent.length, 0),
    headings: [...document.querySelectorAll('.flow-source.is-heading')].slice(0, 3).map((el) => el.textContent.slice(0, 30)),
    paragraphs: sources.map((el) => el.textContent.slice(0, 46)),
    firstTranslations: targets.slice(0, 2).map((el) => el.textContent.slice(0, 30)),
    /** 粗体 / 斜体片段的渲染数量 —— 用来确认论文的段首小标题与斜体术语没丢 */
    strongCount: document.querySelectorAll('.flow-source strong').length,
    emCount: document.querySelectorAll('.flow-source em').length,
    boldSamples: [...document.querySelectorAll('.flow-source strong')]
      .slice(0, 3)
      .map((el) => el.textContent.slice(0, 34)),
    /** 粗体 / 斜体片段的渲染数量 —— 用来确认论文的段首小标题与斜体术语没丢 */
    strongCount: document.querySelectorAll('.flow-source strong').length,
    emCount: document.querySelectorAll('.flow-source em').length,
    boldSamples: [...document.querySelectorAll('.flow-source strong')]
      .slice(0, 3)
      .map((el) => el.textContent.slice(0, 34)),
    /** 面板文本里带「图形坐标可信度」，抽出来便于标定阈值 */
    geometryLine: [...document.querySelectorAll('.report-card li')]
      .map((li) => li.textContent)
      .find((t) => t.includes('图形坐标可信度')) ?? null,
    panels: panelTexts,
  };
})()`;

async function clickZoom(cdp, label) {
  await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.trim() === '${label}');
    if (btn) btn.click();
    return Boolean(btn);
  })()`);
}

async function waitForRender(cdp, minTranslations, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await cdp.evaluate(
      `({ count: document.querySelectorAll('.flow-source').length, error: Boolean(document.querySelector('.error')) })`
    );
    if (state.error) throw new Error('页面报错，见 .error 元素');
    if (state.count >= minTranslations) return state.count;
    await sleep(300);
  }
  return 0;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

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
      '--user-data-dir=/tmp/edge-cdp-profile',
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

    await cdp.send('Page.navigate', { url: URL_TO_OPEN });
    console.log(`已打开 ${URL_TO_OPEN}`);

    const count = await waitForRender(cdp, 1);
    if (count === 0) throw new Error('等待渲染超时：没有出现可选中段落');
    await sleep(800);

    const results = {};
    for (const label of ['100%', '150%', '200%']) {
      await clickZoom(cdp, label);
      await sleep(1500);
      results[label] = await cdp.evaluate(MEASURE);
      console.log(`\n── 缩放 ${label} ──`);
      const r = results[label];
      console.log(`流宽 ${r.flowWidth} | 内容高 ${r.contentHeight}`);
      console.log(`可选中段落 ${r.sourceCount} | 译文 ${r.targetCount} | 图像切片 ${r.sliceCount} | 空切片 ${r.emptySlices} | 全白切片 ${r.blankSlices}`);
      console.log(`可选中的纯文本字符数 ${r.selectableChars}`);
      console.log(`正文字号 ${r.medianSourceFontSize}px | 段落中位高 ${r.medianSourceHeight}`);
      if (r.geometryLine) console.log(` 图形坐标: ${r.geometryLine}`);
      console.log(`粗体片段 ${r.strongCount} | 斜体片段 ${r.emCount}` + (r.boldSamples.length ? ` | 例: ${r.boldSamples.join(' / ')}` : ''));
      console.log(`识别出的标题: ${r.headings.join(' / ') || '(无)'}`);
      for (const p of r.panels) console.log(` 面板: ${p}`);
      console.log(` 全部 ${r.paragraphs.length} 段原文:`);
      for (const t of r.paragraphs) console.log(`  ${t}`);
      console.log(' 前 2 段译文:');
      for (const t of r.firstTranslations) console.log(`  ${t}`);
    }

    // 回到 150% 截图
    await clickZoom(cdp, '150%');
    await sleep(1500);
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    const shotPath = resolve(OUT_DIR, 'render-check.png');
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log(`\n截图已保存: ${shotPath}`);

    const jsonPath = resolve(OUT_DIR, 'render-check.json');
    writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`测量数据已保存: ${jsonPath}`);
  } finally {
    cdp?.close();
    edge.kill('SIGKILL');
  }
}

main().catch((e) => {
  console.error('验证失败:', e.message);
  process.exitCode = 1;
});
