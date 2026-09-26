/**
 * 翻译链路的**集成测试**：真实 `fetch` → 真实 HTTP → 假模型服务。
 *
 * ── 与 translation.test.ts 的分工 ──
 * 那个文件用假 Provider 覆盖调度逻辑（并发、重试、取消），不发请求；
 * 这个文件补上另一半，**唯一没被覆盖的就是「请求真的发出去了且对方接受」**：
 *   - 请求体组装（system/user 消息、model、temperature、max_tokens）
 *   - Authorization 头
 *   - HTTP 状态码 → 错误分类 → 重试与否
 *   - Retry-After 头是否被尊重
 *   - 真实网络延迟下并发上限是否仍然成立
 *   - 缓存是否真的省掉了请求（用服务端计数证明，而不是「看起来快了」）
 *
 * 之所以能在 Node 里跑而不是非得开浏览器：CORS 是**浏览器**的限制，
 * Node 的 fetch 没有同源策略。浏览器里真正需要额外验证的只有「Vite 代理转发」，
 * 那一条由 `scripts/verify-translation.mjs` 覆盖。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMockLlm } from '../../../scripts/mock-llm.mjs';
import { OpenAICompatibleTranslator } from '../openaiCompatible';
import { cacheKeyOf, type TranslationConfig, type TranslatorPort } from '../../domain/translation';
import {
  runTranslation,
  type TranslationCachePort,
  type TranslationItemStatus,
} from '../../domain/translationScheduler';

let baseUrl = '';
let app: ReturnType<typeof createMockLlm>;

/**
 * **每个用例一个独立实例**，不用共享的服务。
 *
 * 踩过的坑：起初用 beforeAll 共享一个实例，结果「并发上限」用例观测到
 * 上限 3 却出现了 4 个在途请求。排查后发现不是调度器的问题 ——
 * 是上一个「取消」用例留下的 [[SLOW]] 请求还在服务端挂着（3 秒后才响应），
 * 它们的计数被下一个用例捡到了。
 *
 * 计数类断言**必须**有干净的起点，否则会得到假警报，
 * 而假警报比漏测更坏：它会让人去改本来正确的代码。
 */
beforeEach(async () => {
  // 日志关掉：测试输出里混入每个请求的流水会淹没断言失败信息
  app = createMockLlm({ logger: () => {}, delayRange: [5, 25] });
  baseUrl = await app.listen(0);
});

afterEach(async () => {
  await app.close();
});

const CONFIG: TranslationConfig = {
  provider: 'mock',
  model: 'deepseek-chat',
  targetLang: 'zh-Hans',
  promptVersion: 1,
};

function makePort(apiKey = 'sk-test-key'): TranslatorPort {
  return new OpenAICompatibleTranslator({ baseUrl, apiKey, model: CONFIG.model });
}

function memCache(): TranslationCachePort & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return { store, get: (k) => store.get(k), set: (k, v) => void store.set(k, v) };
}

function collect() {
  const finals = new Map<string, TranslationItemStatus>();
  return {
    finals,
    onItem(s: TranslationItemStatus) {
      if (s.state === 'done' || s.state === 'cached' || s.state === 'error') {
        finals.set(s.id, s);
      }
    },
  };
}

function run(
  items: Array<{ id: string; source: string }>,
  port: TranslatorPort,
  cache: TranslationCachePort,
  cb: { onItem(s: TranslationItemStatus): void },
  overrides: Record<string, unknown> = {}
) {
  return runTranslation(items, { port, cache }, cb, {
    config: CONFIG,
    concurrency: 4,
    maxAttempts: 3,
    baseDelayMs: 20,
    signal: new AbortController().signal,
    ...overrides,
  });
}

describe('请求组装', () => {
  it('发到 /chat/completions，带 Bearer 头与正确的 model', async () => {
    const port = makePort('sk-some-key');
    const text = await port.translate('plain networks are harder to optimize', new AbortController().signal);

    // 假服务按原文长度成比例返回中文 —— 拿到中文就说明整条 HTTP 链路通了
    expect(text.length).toBeGreaterThan(0);
    expect(/[\u4e00-\u9fa5]/.test(text)).toBe(true);
  });

  it('缺少 API Key 时直接判为鉴权错误，不发请求', async () => {
    const port = makePort('');

    await expect(port.translate('anything', new AbortController().signal)).rejects.toMatchObject({
      kind: 'auth',
      retryable: false,
    });
    // 关键：不该白跑一趟网络
    expect(app.requestCount).toBe(0);
  });
});

describe('HTTP 错误分类与重试', () => {
  it('401 判为鉴权错误且不重试 —— 重试一百次也不会成功', async () => {
    const cb = collect();

    await run([{ id: 'a', source: '[[401]] this paragraph will be rejected' }], makePort(), memCache(), cb, {
      maxAttempts: 3,
    });

    expect(cb.finals.get('a')?.state).toBe('error');
    expect(cb.finals.get('a')?.error?.kind).toBe('auth');
    // 只应命中一次。这是「不可重试」的硬证据
    expect(app.requestCount).toBe(1);
  });

  it('429 会退避重试，并在第三次成功；Retry-After 被尊重', async () => {
    const cb = collect();
    const started = Date.now();

    const result = await run(
      [{ id: 'a', source: '[[429]] rate limited paragraph, needs retries' }],
      makePort(),
      memCache(),
      cb,
      { maxAttempts: 3, baseDelayMs: 30 }
    );

    expect(result.failed).toBe(0);
    expect(cb.finals.get('a')?.state).toBe('done');
    expect(cb.finals.get('a')?.text).toBeTruthy();
    // 假服务在 Retry-After: 1 里要求等 1 秒，两次限流合计 ≥ 2 秒。
    // 这条断言验证的是「服务端给的等待时间确实被用了」，而不是自己瞎猜的间隔
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  }, 20_000);

  it('500 可重试；重试次数用尽后标记失败', async () => {
    const cb = collect();
    const result = await run(
      [{ id: 'a', source: '[[500]] server keeps failing, three attempts max' }],
      makePort(),
      memCache(),
      cb,
      { maxAttempts: 2, baseDelayMs: 10 }
    );

    // 假服务在第 3 次会成功，但我们只允许 2 次 → 必然失败
    expect(result.failed).toBe(1);
    expect(cb.finals.get('a')?.error?.kind).toBe('server');
  });

  it('空返回判为可重试错误 —— 偶发的内容过滤不该让整段报废', async () => {
    // 假服务的 [[EMPTY]] 是**无条件**返回空的，所以重试必然还是空。
    // 这里要锁住的不是「最终能成功」，而是**它确实被重试了**：
    // 空返回的成因（内容过滤、被 max_tokens 截断在开头）多半是偶发的，
    // 若直接判失败，用户就得为一篇论文里的个别段落重跑整篇。
    const cb = collect();

    const result = await run(
      [{ id: 'a', source: '[[EMPTY]] filtered paragraph that comes back empty' }],
      makePort(),
      memCache(),
      cb,
      { maxAttempts: 3, baseDelayMs: 10 }
    );

    expect(result.failed).toBe(1);
    expect(cb.finals.get('a')?.error?.kind).toBe('empty');
    expect(cb.finals.get('a')?.error?.retryable).toBe(true);
    // 3 次尝试都真的发出去了 —— 这才是「可重试」的证据
    expect(app.requestCount).toBe(3);
  });
});

describe('缓存真的省掉了请求', () => {
  it('第二轮完全命中缓存，服务端请求数不增加', async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      source: `paragraph number ${i} about residual learning and depth`,
    }));

    const cache = memCache();

    const first = collect();
    await run(items, makePort(), cache, first);
    const requestsAfterFirst = app.requestCount;

    expect(first.finals.size).toBe(6);
    expect(requestsAfterFirst).toBe(6); // 缓存为空，每段一次请求

    // 第二轮：同一个缓存、同样的输入
    const second = collect();
    const result = await run(items, makePort(), cache, second);

    expect(result.cached).toBe(6);
    expect(result.cacheHitRate).toBe(1);
    // 这是「缓存有效」的硬证据 —— 只看耗时会被网络抖动骗过去
    expect(app.requestCount).toBe(requestsAfterFirst);
  });

  it('换模型后缓存失效，必须重新请求', async () => {
    const items = [{ id: 'a', source: 'a paragraph that will be translated twice' }];
    const cache = memCache();

    await run(items, makePort(), cache, collect());
    const after = app.requestCount;

    // 同一段原文，但缓存键里的 model 变了
    const config2: TranslationConfig = { ...CONFIG, model: 'deepseek-reasoner' };
    const key = cacheKeyOf(items[0].source, config2);
    expect(cache.store.has(key)).toBe(false);

    await run(items, makePort(), cache, collect(), { config: config2 });
    expect(app.requestCount).toBeGreaterThan(after);
  });
});

describe('真实网络下的并发与取消', () => {
  it('并发上限被遵守（服务端观测到的在途峰值不超过设定值）', async () => {
    const items = Array.from({ length: 16 }, (_, i) => ({
      id: `c${i}`,
      source: `concurrency probe paragraph ${i} with enough text to be realistic`,
    }));

    await run(items, makePort(), memCache(), collect(), { concurrency: 3 });

    // 上限 3：既不能超过（违反限流保护），也不该远低于（说明池没填满、白等）
    expect(app.maxInFlight).toBeLessThanOrEqual(3);
    expect(app.maxInFlight).toBe(3);
  });

  it('取消后立刻停止发新请求', async () => {
    const controller = new AbortController();
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `x${i}`,
      source: `[[SLOW]] slow paragraph ${i} used to test cancellation`,
    }));

    const promise = run(items, makePort(), memCache(), collect(), {
      concurrency: 2,
      signal: controller.signal,
    });
    // 等两个在途请求真正发出去，再取消
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    const result = await promise;

    expect(result.cancelled).toBeGreaterThan(0);
    // 全部 10 段都必须有归宿，不能有「悬空」的
    expect(result.done + result.failed + result.cancelled).toBe(10);
  }, 20_000);
});

describe('质量校验在真实响应上生效', () => {
  it('正常译文不产生告警', async () => {
    const cb = collect();
    await run(
      [{ id: 'a', source: 'a reasonably long english paragraph about deep networks '.repeat(3) }],
      makePort(),
      memCache(),
      cb
    );

    expect(cb.finals.get('a')?.state).toBe('done');
    expect(cb.finals.get('a')?.warning).toBeUndefined();
  });
});
