import { describe, expect, it } from 'vitest';

import {
  TranslationError,
  cacheKeyOf,
  checkTranslationQuality,
  hashText,
  type TranslationConfig,
  type TranslatorPort,
} from '../translation';
import {
  runTranslation,
  type SchedulerCallbacks,
  type TranslationCachePort,
  type TranslationItemState,
} from '../translationScheduler';

const CONFIG: TranslationConfig = {
  provider: 'test',
  model: 'test-model',
  targetLang: 'zh-Hans',
  promptVersion: 1,
};

/** 内存缓存，可控 */
function memCache(initial: Record<string, string> = {}): TranslationCachePort & {
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: (k) => store.get(k),
    set: (k, v) => void store.set(k, v),
  };
}

/** 记录每次调用的假 Provider，按预设脚本返回或抛错 */
function fakePort(script: Array<string | Error>): TranslatorPort & {
  calls: string[];
  maxConcurrent: number;
} {
  const calls: string[] = [];
  let concurrent = 0;
  const self = {
    calls,
    maxConcurrent: 0,
    async translate(source: string, signal?: AbortSignal): Promise<string> {
      // 必须尊重 signal：真实适配器会响应取消，假 Provider 不响应的话
      // 「取消」这类用例就测不出真实行为
      if (signal?.aborted) throw new TranslationError('aborted', '已取消');
      const step = script.shift();
      concurrent += 1;
      self.maxConcurrent = Math.max(self.maxConcurrent, concurrent);
      try {
        // 让出一轮事件循环，使并发真的可能重叠
        await new Promise((r) => setTimeout(r, 0));
        if (signal?.aborted) throw new TranslationError('aborted', '已取消');
        if (step instanceof Error) throw step;
        calls.push(source);
        return step ?? '默认译文内容';
      } finally {
        concurrent -= 1;
      }
    },
  };
  return self;
}

/** 收集回调，便于断言状态序列 */
function collector(): SchedulerCallbacks & {
  states: Array<{ id: string; state: TranslationItemState }>;
  finals: Map<string, { state: TranslationItemState; text?: string; warning?: string }>;
} {
  const states: Array<{ id: string; state: TranslationItemState }> = [];
  const finals = new Map<string, any>();
  return {
    states,
    finals,
    onItem(s) {
      states.push({ id: s.id, state: s.state });
      if (s.state === 'done' || s.state === 'cached' || s.state === 'error') {
        finals.set(s.id, { state: s.state, text: s.text, warning: s.warning });
      }
    },
  };
}

/** 零等待的 sleep，避免测试真的等退避 */
const instantSleep = () => Promise.resolve();

function run(
  items: Array<{ id: string; source: string }>,
  port: TranslatorPort,
  cache: TranslationCachePort,
  cb: SchedulerCallbacks,
  overrides: Partial<Parameters<typeof runTranslation>[3]> = {}
) {
  return runTranslation(
    items,
    { port, cache },
    cb,
    {
      config: CONFIG,
      concurrency: 4,
      maxAttempts: 3,
      baseDelayMs: 10,
      signal: new AbortController().signal,
      sleep: instantSleep,
      ...overrides,
    }
  );
}

describe('缓存键', () => {
  it('组成项全部参与，任一变化都得到不同的键', () => {
    const base = cacheKeyOf('source text', CONFIG);
    expect(cacheKeyOf('source text', CONFIG)).toBe(base);
    expect(cacheKeyOf('other text', CONFIG)).not.toBe(base);
    expect(cacheKeyOf('source text', { ...CONFIG, model: 'other' })).not.toBe(base);
    expect(cacheKeyOf('source text', { ...CONFIG, provider: 'other' })).not.toBe(base);
    expect(cacheKeyOf('source text', { ...CONFIG, targetLang: 'en' })).not.toBe(base);
    // 提示词版本必须参与 —— 漏了它，改完提示词会命中旧缓存，
    // 表现为「改了没生效」，极难排查
    expect(cacheKeyOf('source text', { ...CONFIG, promptVersion: 2 })).not.toBe(base);
  });

  it('哈希稳定且长度固定', () => {
    expect(hashText('residual learning')).toBe(hashText('residual learning'));
    expect(hashText('residual learning')).toHaveLength(16);
    expect(hashText('a')).not.toBe(hashText('b'));
  });
});

describe('质量校验', () => {
  it('译文为空 → 告警', () => {
    expect(checkTranslationQuality('some source text here', '   ')).toMatch(/为空/);
  });

  it('译文里没有中文 → 告警（模型把原文抄回来了）', () => {
    expect(checkTranslationQuality('deep residual learning framework', 'deep residual learning')).toMatch(
      /没有中文/
    );
  });

  it('长度比例离谱 → 告警；正常比例 → 通过', () => {
    const source = 'a'.repeat(200);
    expect(checkTranslationQuality(source, '短')).toMatch(/过短/);
    expect(checkTranslationQuality(source, '中'.repeat(800))).toMatch(/过长/);
    expect(checkTranslationQuality(source, '中'.repeat(120))).toBeNull();
  });

  it('短片段不判比例（标题、题注波动大）', () => {
    expect(checkTranslationQuality('Figure 3.', '图 3。')).toBeNull();
  });
});

describe('调度器', () => {
  it('全部成功：状态机走 running → done，缓存写入', async () => {
    const port = fakePort(['译文一', '译文二', '译文三']);
    const cache = memCache();
    const cb = collector();

    const result = await run(
      [
        { id: 'a', source: 'alpha source' },
        { id: 'b', source: 'beta source' },
        { id: 'c', source: 'gamma source' },
      ],
      port,
      cache,
      cb
    );

    expect(result).toMatchObject({ total: 3, done: 3, cached: 0, failed: 0 });
    expect(cb.finals.get('a')?.text).toBe('译文一');
    expect(cb.states.filter((s) => s.state === 'running')).toHaveLength(3);
    // 每段都进了缓存
    expect(cache.store.size).toBe(3);
  });

  it('缓存命中：不发请求，状态标为 cached 而不是 done', async () => {
    // 区分这两个状态是有意义的 —— 面板要显示「命中 N 段」来体现缓存的收益
    const key = cacheKeyOf('already translated', CONFIG);
    const port = fakePort([]);
    const cache = memCache({ [key]: '已有的译文' });
    const cb = collector();

    const result = await run([{ id: 'a', source: 'already translated' }], port, cache, cb);

    expect(port.calls).toHaveLength(0);
    expect(result).toMatchObject({ done: 1, cached: 1, cacheHitRate: 1 });
    expect(cb.finals.get('a')).toMatchObject({ state: 'cached', text: '已有的译文' });
  });

  it('限流后重试成功：只对 429 退避重试', async () => {
    const port = fakePort([
      new TranslationError('rate-limit', '限流'),
      new TranslationError('rate-limit', '限流'),
      '最终译文',
    ]);
    const cb = collector();

    const result = await run([{ id: 'a', source: 'retry me' }], port, memCache(), cb);

    expect(result.failed).toBe(0);
    expect(cb.finals.get('a')?.text).toBe('最终译文');
    // 两次失败 + 一次成功 = 3 次 running
    expect(cb.states.filter((s) => s.state === 'running')).toHaveLength(3);
  });

  it('鉴权失败不重试 —— 401 重试一百次也不会成功', async () => {
    const port = fakePort([new TranslationError('auth', 'Key 无效')]);
    const cb = collector();

    const result = await run([{ id: 'a', source: 'x' }], port, memCache(), cb);

    const errorState = cb.finals.get('a');
    expect(errorState?.state).toBe('error');
    expect(result.failed).toBe(1);
    expect(cb.states.filter((s) => s.state === 'running')).toHaveLength(1);
  });

  it('用尽重试次数后标记失败，且不影响其他段落', async () => {
    const port = fakePort([
      new TranslationError('server', '5xx'),
      new TranslationError('server', '5xx'),
      new TranslationError('server', '5xx'),
      '好段落的译文',
    ]);
    const cb = collector();

    const result = await run(
      [
        { id: 'bad', source: 'bad source' },
        { id: 'good', source: 'good source' },
      ],
      port,
      memCache(),
      cb,
      { concurrency: 1 }
    );

    expect(result.failed).toBe(1);
    expect(result.done).toBe(1);
    expect(cb.finals.get('bad')?.state).toBe('error');
    expect(cb.finals.get('good')?.text).toBe('好段落的译文');
  });

  it('遵守并发上限', async () => {
    const port = fakePort(Array.from({ length: 12 }, (_, i) => `译文${i}`));
    const cache = memCache();
    const cb = collector();

    await run(
      Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, source: `source ${i}` })),
      port,
      cache,
      cb,
      { concurrency: 3 }
    );

    expect(port.maxConcurrent).toBeLessThanOrEqual(3);
    expect(cache.store.size).toBe(12);
  });

  it('取消后剩余项标为 cancelled，已完成的保留', async () => {
    // ── 取消的触发必须是**确定性的** ──
    // 最初用 `setTimeout(() => controller.abort(), 5)`。这个写法是时序脆弱的：
    // 机器一忙、或者假 Provider 变快，整批就在 5ms 内跑完了，
    // 断言 `cancelled > 0` 随机失败 —— 一次假警报。
    // 改成「第一段完成时立刻取消」：此时 worker 正要领取第二段，
    // 一定会在循环顶部看到 aborted 而中断，结果完全可预测。
    const controller = new AbortController();
    const port = fakePort(Array.from({ length: 6 }, (_, i) => `译文${i}`));
    const cb = collector();
    let aborted = false;

    const promise = run(
      Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, source: `source ${i}` })),
      port,
      memCache(),
      {
        onItem(status) {
          cb.onItem(status);
          if (!aborted && status.state === 'done') {
            aborted = true;
            controller.abort();
          }
        },
      },
      { concurrency: 1, signal: controller.signal }
    );
    const result = await promise;

    expect(aborted).toBe(true);
    expect(result.cancelled).toBeGreaterThan(0);
    expect(result.done).toBeGreaterThan(0);
    // 所有项都必须有归宿，不能有「悬空」的
    expect(result.done + result.failed + result.cancelled).toBe(6);
  });

  it('空返回视为可重试 —— 多半是偶发的内容过滤', async () => {
    const port = fakePort([new TranslationError('empty', '空返回'), '重试后的译文']);
    const cb = collector();

    const result = await run([{ id: 'a', source: 'x' }], port, memCache(), cb);

    expect(result.failed).toBe(0);
    expect(cb.finals.get('a')?.text).toBe('重试后的译文');
  });

  it('可疑译文仍然交付，但带告警 —— 不能让用户以为它是好译文', async () => {
    // 模型把原文照抄回来了
    const port = fakePort(['This is the untranslated original text']);
    const cb = collector();

    await run([{ id: 'a', source: 'a'.repeat(200) }], port, memCache(), cb);

    const final = cb.finals.get('a');
    expect(final?.state).toBe('done'); // 仍然可用
    expect(final?.text).toBeTruthy();
    expect(final?.warning).toMatch(/没有中文/);
  });

  it('空输入不报错', async () => {
    const cb = collector();
    const result = await run([], fakePort([]), memCache(), cb);
    expect(result).toMatchObject({ total: 0, done: 0, failed: 0, cacheHitRate: 0 });
  });

  it('进度回调的合计始终等于总数', async () => {
    const seen: Array<{ total: number; done: number; failed: number }> = [];
    const port = fakePort([
      '一段译文',
      new TranslationError('auth', 'x'),
      '另一段译文',
    ]);

    await run(
      [
        { id: 'a', source: 's1' },
        { id: 'b', source: 's2' },
        { id: 'c', source: 's3' },
      ],
      port,
      memCache(),
      {
        onItem: () => {},
        onProgress: (p) => seen.push({ total: p.total, done: p.done, failed: p.failed }),
      },
      { concurrency: 1 }
    );

    for (const p of seen) {
      expect(p.total).toBe(3);
      expect(p.done + p.failed).toBeLessThanOrEqual(3);
    }
    const last = seen[seen.length - 1];
    expect(last.done + last.failed).toBe(3);
  });
});
