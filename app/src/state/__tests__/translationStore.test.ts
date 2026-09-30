import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockLlm } from '../../../scripts/mock-llm.mjs';

/**
 * 译文仓库（store）的端到端测试：登记 → 触发 → 真实 HTTP → 逐段回填。
 *
 * ── 为什么这一层值得单独测 ──
 * UI 之下真正容易出错的是接线：段落何时登记、重复登记会不会把状态撑爆、
 * 逐段回填是否真的「逐段」（而不是等全部跑完才一次性出现）、
 * 重复点击是否命中缓存。这些都不需要 DOM，但都需要真实网络。
 *
 * 用 `vi.resetModules()` + 动态 import 拿到**全新的单例**：
 * 仓库是模块级单例（这是有意的设计，见 translationStore.ts 的注释），
 * 而计数类断言必须有干净起点 —— 共享实例会让上一个用例的余波变成假警报。
 */
let baseUrl = '';
let app: ReturnType<typeof createMockLlm>;

beforeEach(async () => {
  app = createMockLlm({ logger: () => {}, delayRange: [3, 15] });
  baseUrl = await app.listen(0);
  vi.resetModules();
});

afterEach(async () => {
  await app.close();
});

/** 拿到全新的 store / settings，并把设置指向本次的假服务 */
async function freshStore(options: { apiKey?: string; concurrency?: number } = {}) {
  const { translationStore } = await import('../translationStore');
  const { updateTranslationSettings } = await import('../translationSettings');

  updateTranslationSettings({
    provider: 'mock',
    baseUrl,
    apiKey: options.apiKey ?? 'sk-test-key',
    model: 'deepseek-chat',
    concurrency: options.concurrency ?? 4,
    maxAttempts: 2,
    baseDelayMs: 10,
    // 关掉预览占位：否则分不清拿到的是真译文还是本地拼的句子
    previewMode: false,
  });

  return translationStore;
}

describe('段落登记', () => {
  it('登记是幂等的 —— 重复登记不能让状态无限增长', async () => {
    // 这条是硬要求：页面在缩放切换、重渲染时都会重新登记。
    // 若不幂等，快照会不断更新，而快照更新又触发重渲染 → 无限循环。
    const store = await freshStore();
    const blocks = [
      { id: 'b1', text: 'first paragraph about depth' },
      { id: 'b2', text: 'second paragraph about accuracy' },
    ];

    store.register(blocks);
    expect(store.sourceCount).toBe(2);
    expect(store.getSnapshot().registered).toBe(2);

    store.register(blocks);
    store.register(blocks);
    expect(store.sourceCount).toBe(2);
    expect(store.getSnapshot().registered).toBe(2);
  });

  it('空文本不登记（避免把空白送给模型白白计费）', async () => {
    const store = await freshStore();
    store.register([
      { id: 'ok', text: 'a real paragraph' },
      { id: 'blank', text: '   ' },
      { id: 'empty', text: '' },
    ]);
    expect(store.sourceCount).toBe(1);
  });

  it('isRegisteredWith 区分同一 id 下的不同原文（合并登记的幂等守卫用）', async () => {
    const store = await freshStore();
    store.register([{ id: 'b1', text: 'plain text' }]);
    expect(store.isRegisteredWith('b1', 'plain text')).toBe(true);
    // 同 id 换了文本（跨页合并后的整段）→ 不算已登记，允许替换
    expect(store.isRegisteredWith('b1', 'tail text merged with head text')).toBe(false);
    expect(store.isRegisteredWith('missing', 'anything')).toBe(false);
  });

  it('注销移除待译来源与已产生的译文，且幂等（I25 跨页接续）', async () => {
    const store = await freshStore();
    store.register([
      { id: 'tail', text: 'an unfinished trailing fragment about depth' },
      { id: 'head', text: 'and the continuation begins here about accuracy' },
    ]);

    // 幂等：注销不存在的 id 不产生副作用
    store.unregister(['nonexistent']);
    expect(store.getSnapshot().registered).toBe(2);

    // 先把尾块真的译出来（合并判定可能晚于翻译启动）——
    // 注销必须把旧译文一起清掉，否则半段译文会与整段译文叠着显示
    await store.start();
    expect(store.getSnapshot().status).toBe('done');
    expect(store.getSnapshot().byBlockId.has('tail')).toBe(true);

    store.unregister(['tail', 'head']);
    expect(store.sourceCount).toBe(0);
    expect(store.getSnapshot().registered).toBe(0);
    expect(store.getSnapshot().byBlockId.has('tail')).toBe(false);
    expect(store.getSnapshot().byBlockId.has('head')).toBe(false);
    expect(store.isRegisteredWith('tail', 'an unfinished trailing fragment about depth')).toBe(false);

    // 注销后可重新登记（合并单元走宿主块的 id）
    const mergedText = 'an unfinished trailing fragment about depth and the continuation begins here about accuracy';
    store.register([{ id: 'head', text: mergedText }]);
    expect(store.isRegisteredWith('head', mergedText)).toBe(true);
    expect(store.sourceCount).toBe(1);
  });
});

describe('缓存自动恢复（重开文档译文秒回）', () => {
  it('翻译过的段落重新注册后自动从缓存回填，不需要 Key、不发请求', async () => {
    const store = await freshStore();
    const text = 'a cached paragraph about transformers';
    store.register([{ id: 'b1', text }]);
    await store.start();
    expect(store.getSnapshot().byBlockId.get('b1')).toBeTruthy();

    // 模拟重开：换文档 reset（内存清空）→ 同一段原文以新块 id 重新注册
    store.reset();
    expect(store.getSnapshot().byBlockId.size).toBe(0);
    store.register([{ id: 'b9', text }]);
    store.restoreFromCache();

    expect(store.getSnapshot().byBlockId.get('b9')).toBeTruthy();
    // 恢复不是一次翻译运行 —— 状态仍是 idle，没有进度
    expect(store.getSnapshot().status).toBe('idle');
    expect(store.getSnapshot().progress.total).toBe(0);
  });

  it('未缓存的段落恢复时不产生译文，保持原文待译', async () => {
    const store = await freshStore();
    store.register([{ id: 'x1', text: 'never translated before' }]);
    store.restoreFromCache();
    expect(store.getSnapshot().byBlockId.has('x1')).toBe(false);
    expect(store.getSnapshot().registered).toBe(1);
  });

  it('清空译文后不再自动恢复 —— 用户主动清空是要求重译，回填会跟用户对着干', async () => {
    const store = await freshStore();
    store.register([{ id: 'b1', text: 'cached once more' }]);
    await store.start();
    store.clearTranslations();
    expect(store.getSnapshot().byBlockId.size).toBe(0);

    store.restoreFromCache();
    expect(store.getSnapshot().byBlockId.size).toBe(0);
  });
});

describe('一键翻译的完整流程', () => {
  it('译文逐段回填，且进度合计等于段落数', async () => {
    const store = await freshStore({ concurrency: 2 });
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      text: `paragraph ${i} discussing residual connections and optimization difficulty`,
    }));
    store.register(items);

    // 用订阅来观察「回填是否真的是增量的」：
    // 若实现是「全部跑完再一次性写入」，那么只会观察到一次尺寸跳变
    const sizeHistory: number[] = [];
    const unsubscribe = store.subscribe(() => {
      sizeHistory.push(store.getSnapshot().byBlockId.size);
    });

    await store.start();
    unsubscribe();

    const snapshot = store.getSnapshot();
    expect(snapshot.byBlockId.size).toBe(8);
    expect(snapshot.status).toBe('done');
    expect(snapshot.progress.total).toBe(8);
    expect(snapshot.progress.done).toBe(8);
    expect(snapshot.progress.failed).toBe(0);

    // 增量证据：出现过 0 < size < 8 的中间态
    expect(sizeHistory.some((n) => n > 0 && n < 8)).toBe(true);

    // 端到端证明译文真的是中文（来自假服务按比例生成的中文句子）
    for (const value of snapshot.byBlockId.values()) {
      expect(/[\u4e00-\u9fa5]/.test(value)).toBe(true);
    }
  });

  it('第二次点击全部命中缓存，不再发请求', async () => {
    const store = await freshStore();
    const items = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      text: `cache probe paragraph ${i} with enough words to be realistic`,
    }));
    store.register(items);

    await store.start();
    const requestsAfterFirst = app.requestCount;
    expect(requestsAfterFirst).toBe(5);

    // 再点一次。注意不是「重新跑一遍」—— 已有译文的段落会被跳过
    await store.start();

    expect(app.requestCount).toBe(requestsAfterFirst);
    expect(store.getSnapshot().byBlockId.size).toBe(5);
    // 消息里要能看出「没花新钱」
    expect(store.getSnapshot().message).toMatch(/都已翻译完成|命中缓存/);
  });

  it('失败段落落到 errors，且不影响其他段落', async () => {
    const store = await freshStore({ concurrency: 1 });
    store.register([
      { id: 'bad', text: '[[401]] this one will be rejected by auth' },
      { id: 'good', text: 'this paragraph translates just fine and is long enough' },
    ]);

    await store.start();
    const snapshot = store.getSnapshot();

    expect(snapshot.byBlockId.size).toBe(1);
    expect(snapshot.byBlockId.get('good')).toBeTruthy();
    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.errors[0].message).toMatch(/Key|401/);
    expect(snapshot.status).toBe('failed');
  });

  it('未配置 API Key 时给出可读的报错，而不是静默不动', async () => {
    // 静默失败是最坏的体验：用户点了按钮，什么都没发生，猜不出原因
    const store = await freshStore({ apiKey: '' });
    store.register([{ id: 'a', text: 'a paragraph that needs a key to translate' }]);

    await store.start();
    const snapshot = store.getSnapshot();

    expect(snapshot.status).toBe('failed');
    expect(snapshot.errors[0].message).toMatch(/API Key/);
    // 且一个请求都不该发出去
    expect(app.requestCount).toBe(0);
  });

  it('没有待翻译段落时给出提示，而不是空转', async () => {
    const store = await freshStore();
    await store.start();
    expect(store.getSnapshot().message).toMatch(/还没有可翻译的段落/);
  });

  it('清空译文后可以重译，且仍能命中缓存', async () => {
    const store = await freshStore();
    store.register([{ id: 'a', text: 'paragraph for the clear transl text flow' }]);

    await store.start();
    expect(store.getSnapshot().byBlockId.size).toBe(1);
    const afterFirst = app.requestCount;

    store.clearTranslations();
    expect(store.getSnapshot().byBlockId.size).toBe(0);

    await store.start();
    expect(store.getSnapshot().byBlockId.size).toBe(1);
    // 清空的是译文展示，不是缓存 —— 重译不该再花钱
    expect(app.requestCount).toBe(afterFirst);
  });
});

describe('取消', () => {
  it('取消后状态标为 cancelled，已完成的部分保留', async () => {
    const store = await freshStore({ concurrency: 1 });
    store.register(
      Array.from({ length: 6 }, (_, i) => ({
        id: `s${i}`,
        text: `[[SLOW]] slow paragraph ${i} kept for the cancellation test`,
      }))
    );

    const promise = store.start();
    await new Promise((r) => setTimeout(r, 250));
    store.cancel();
    await promise;

    const snapshot = store.getSnapshot();
    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.progress.running).toBe(0);
  }, 20_000);
});
