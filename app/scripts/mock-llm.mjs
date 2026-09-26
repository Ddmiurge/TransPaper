#!/usr/bin/env node
/**
 * OpenAI 兼容的**本地假模型服务**，用于在没有 API Key 的情况下验证翻译全链路。
 *
 * ── 为什么需要它 ──
 * 接真实模型前有一堆与模型无关的东西要验证：请求组装是否正确、缓存是否命中、
 * 并发上限是否被遵守、429 是否退避重试、取消是否生效、逐段回填是否流畅。
 * 这些都能用假服务验完，而且**确定性** —— 真实模型的输出每次不同，
 * 反而不好断言。
 *
 * ── 行为 ──
 * - 按输入长度生成等比例的中文文本（保证排版评估有效，与 mock/translations.ts 同源思路）
 * - 落到 stdout 打印每次请求，便于核对请求体
 * - 源文本里带特定标记时返回对应错误，用于测重试路径：
 *     `[[429]]`  → 返回 429（前两次，第三次成功）
 *     `[[401]]`  → 返回 401
 *     `[[500]]`  → 返回 500（前两次）
 *     `[[EMPTY]]`→ 返回空内容
 *     `[[SLOW]]` → 延迟 3 秒，用于测取消
 *
 * ── 两种用法 ──
 *   node scripts/mock-llm.mjs [端口，默认 8787]      # 独立进程，配合浏览器验证
 *   import { createMockLlm } from './mock-llm.mjs'   # 进程内，供集成测试使用
 *
 * 后者让集成测试**自带服务**，不必依赖外部先起一个进程 ——
 * 测试用它监听 0 号端口，天然避免端口冲突。
 */

import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 8787);
const SENTENCES = [
  '实验结果表明，该方法在标准数据集上取得了优于基线的性能。',
  '我们在本节中分析该现象背后的原因，并给出两种可能的解释。',
  '为了验证这一假设，我们在多个规模上重复了实验，结论保持一致。',
  '与已有工作相比，本文的主要贡献在于在简化结构的同时保持精度。',
  '值得注意的是，当网络深度继续增加时，训练误差反而出现上升。',
  '这种退化现象并非由过拟合引起，而是优化难度随深度增加所致。',
  '上述结论在图像分类与目标检测两个任务上均得到了验证。',
  '综合来看，该方案在精度、速度与实现复杂度三者之间取得了较好的平衡。',
];

function hashOf(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

/** 按原文长度生成等比例中文，拼完整句子不截断 */
function fakeTranslation(source) {
  const target = Math.max(16, Math.round(source.length * 0.55));
  const start = hashOf(source) % SENTENCES.length;
  let out = '';
  for (let i = 0; i < SENTENCES.length; i += 1) {
    const next = SENTENCES[(start + i) % SENTENCES.length];
    if (out.length > 0 && out.length + next.length > target * 1.15) break;
    out += next;
    if (out.length >= target) break;
  }
  return out;
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/**
 * 建一个假模型服务（尚未 listen）。
 *
 * @param {{ logger?: (msg: string) => void, delayRange?: [number, number] }} options
 *   logger 默认写 stdout；测试里传空函数可以保持输出干净。
 *   delayRange 用于压缩延迟，让测试跑得快。
 */
export function createMockLlm(options = {}) {
  const logger = options.logger ?? ((msg) => console.log(msg));
  const [minDelay, maxDelay] = options.delayRange ?? [40, 160];
  /** 每个实例独立的计数，避免测试之间互相污染 */
  const localAttempts = new Map();
  let inFlight = 0;
  let maxInFlight = 0;

  const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    sendJson(res, 404, { error: { message: `not found: ${req.method} ${req.url}` } });
    return;
  }

  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: { message: 'invalid JSON' } });
      return;
    }

    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || auth === 'Bearer ') {
      sendJson(res, 401, { error: { message: 'missing api key' } });
      return;
    }

    const userMessage = body.messages?.find((m) => m.role === 'user')?.content ?? '';
    // 并发计数必须**在响应写出的那一刻**递减。
    //
    // 曾经用 `res.on('close')` 递减，实测虚报：keep-alive 下 close 要等连接
    // 回收才触发，而客户端早已收到响应、发出下一个请求。于是「并发上限 3」
    // 被观测成 4 —— 一个纯粹由测量方式造成的假警报。
    // 用一个只生效一次的 respond() 包住「发送 + 计数」，保证不多减也不漏减。
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    let settled = false;
    const respond = (status, payload, headers) => {
      if (!settled) {
        settled = true;
        inFlight -= 1;
      }
      sendJson(res, status, payload, headers);
    };

    const n = (localAttempts.get(userMessage) ?? 0) + 1;
    localAttempts.set(userMessage, n);
    const preview = userMessage.replace(/\s+/g, ' ').slice(0, 52);

    // 故障注入
    if (userMessage.includes('[[429]]')) {
      if (n <= 2) {
        logger(`  ← [429] 第 ${n} 次 :: ${preview}`);
        respond(429, { error: { message: 'rate limit exceeded' } }, { 'Retry-After': '1' });
        return;
      }
    }
    if (userMessage.includes('[[401]]')) {
      logger(`  ← [401] :: ${preview}`);
      respond(401, { error: { message: 'invalid api key' } });
      return;
    }
    if (userMessage.includes('[[500]]') && n <= 2) {
      logger(`  ← [500] 第 ${n} 次 :: ${preview}`);
      respond(500, { error: { message: 'internal error' } });
      return;
    }
    if (userMessage.includes('[[EMPTY]]')) {
      logger(`  ← [EMPTY] :: ${preview}`);
      respond(200, { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] });
      return;
    }

    const delay = userMessage.includes('[[SLOW]]') ? 3000 : minDelay + Math.random() * (maxDelay - minDelay);
    setTimeout(() => {
      const content = fakeTranslation(userMessage);
      logger(
        `  ← [200] model=${body.model} in=${userMessage.length} out=${content.length} :: ${preview}`
      );
      respond(200, {
        id: `mock-${Date.now()}`,
        object: 'chat.completion',
        model: body.model ?? 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: userMessage.length, completion_tokens: content.length },
      });
    }, delay);
  });
});

  return {
    server,
    /** 高峰并发数 —— 测试用它断言「并发上限是否被遵守」 */
    get maxInFlight() {
      return maxInFlight;
    },
    /** 收到的请求总数 */
    get requestCount() {
      return [...localAttempts.values()].reduce((a, b) => a + b, 0);
    },
    /** 监听。传 0 让系统分配空闲端口 */
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          resolve(`http://127.0.0.1:${address.port}`);
        });
      });
    },
    close() {
      // 必须强制断开：慢请求的 setTimeout 还要几秒才响应，
      // 而 keep-alive 连接也不会自己关 —— 只调 server.close() 会一直挂着。
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

// 只有直接运行时才自动起服务。被 import 时不能自动 listen ——
// 否则集成测试一 import 就占用 8787，还会因为端口冲突而失败。
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  const app = createMockLlm();
  app.listen(PORT).then((url) => {
    console.log(`假模型服务已启动：${url}`);
    console.log('  POST /chat/completions  （OpenAI 兼容）');
    console.log('  故障注入：[[429]] [[401]] [[500]] [[EMPTY]] [[SLOW]]');
    console.log('  等待请求…');
  });
}
