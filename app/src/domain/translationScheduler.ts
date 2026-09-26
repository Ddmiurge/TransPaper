import {
  TranslationError,
  cacheKeyOf,
  checkTranslationQuality,
  type TranslationConfig,
  type TranslationRequest,
  type TranslatorPort,
} from './translation';

/**
 * 翻译调度。
 *
 * ── 三条设计原则 ──
 *
 * **① 缓存前置，且在同一个 worker 里做**
 * 缓存命中不能让 worker 空转一轮再返回 —— 大文档里页眉页脚、重复的方法描述
 * 命中率可能到 20%，把命中项的等待压到 0 才能真正体现收益。
 *
 * **② 只重试可重试的错误**
 * 401（Key 错）重试一百次也不会成功，反而把用户的钱和时间烧掉。
 * 错误分类在 `TranslationError.retryable` 里，这里只消费它。
 *
 * **③ 退避带抖动**
 * 并发 4 的情况下，若一批请求同时撞上 429，固定间隔重试会让它们再次同时到达，
 * 反复触发限流。抖动把重试时刻打散。
 */

/** 缓存端口。由基础设施层实现（浏览器里是 localStorage，Tauri 里是 SQLite） */
export interface TranslationCachePort {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export type TranslationItemState =
  /** 尚未开始 */
  | 'queued'
  /** 请求进行中 */
  | 'running'
  /** 已完成（含重试后成功） */
  | 'done'
  /** 命中缓存，未发请求 */
  | 'cached'
  /** 失败（重试次数用尽或不可重试） */
  | 'error';

export interface TranslationItemStatus {
  id: string;
  state: TranslationItemState;
  /** 已完成或命中缓存的译文 */
  text?: string;
  /** 质量校验的告警（有译文但可疑） */
  warning?: string;
  error?: TranslationError;
  /** 已尝试次数，从 1 开始 */
  attempts: number;
}

export interface SchedulerCallbacks {
  /** 单项状态变化。**逐项回调是必需的** —— 前端靠它增量回填译文 */
  onItem(status: TranslationItemStatus): void;
  /** 整体进度。done 已含缓存命中 */
  onProgress?(p: {
    total: number;
    done: number;
    cached: number;
    failed: number;
    running: number;
  }): void;
}

export interface SchedulerOptions {
  config: TranslationConfig;
  /** 并发上限。对 DeepSeek 这类限流较松的服务，4–6 是稳妥值 */
  concurrency: number;
  /** 单段最多尝试次数（含首次） */
  maxAttempts: number;
  /** 退避基数（毫秒）。实际等待 = base * 2^(attempt-1) * jitter */
  baseDelayMs: number;
  signal: AbortSignal;
  /** 注入 sleep 便于测试。默认用 setTimeout */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface SchedulerResult {
  total: number;
  done: number;
  cached: number;
  failed: number;
  /** 命中率，用于评估缓存的实际价值 */
  cacheHitRate: number;
  /** 因用户取消而未完成的项数 */
  cancelled: number;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new TranslationError('aborted', '已取消'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TranslationError('aborted', '已取消'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * 跑完一批翻译。
 *
 * 本函数不抛错：所有失败都通过 `onItem` 汇报为 `state: 'error'`，
 * 因为「一段失败」不该让整篇翻译中断 —— 用户要的是尽可能多的可用译文。
 * 只有 AbortSignal 触发的取消会提前返回（也已把未完成项标为 error/aborted）。
 */
export async function runTranslation(
  items: TranslationRequest[],
  deps: { port: TranslatorPort; cache: TranslationCachePort },
  callbacks: SchedulerCallbacks,
  options: SchedulerOptions
): Promise<SchedulerResult> {
  const { port, cache } = deps;
  const sleep = options.sleep ?? defaultSleep;
  const total = items.length;

  let done = 0;
  let cached = 0;
  let failed = 0;
  let cancelled = 0;
  let running = 0;
  let cursor = 0;

  const emitProgress = () =>
    callbacks.onProgress?.({ total, done, cached, failed, running });

  emitProgress();

  const processOne = async (item: TranslationRequest): Promise<void> => {
    const key = cacheKeyOf(item.source, options.config);

    // ── 缓存前置 ──
    const hit = cache.get(key);
    if (hit !== undefined) {
      cached += 1;
      done += 1;
      callbacks.onItem({ id: item.id, state: 'cached', text: hit, attempts: 0 });
      emitProgress();
      return;
    }

    running += 1;
    emitProgress();

    let lastError: TranslationError | undefined;

    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      if (options.signal.aborted) {
        lastError = new TranslationError('aborted', '已取消');
        break;
      }

      callbacks.onItem({ id: item.id, state: 'running', attempts: attempt });

      try {
        const text = await port.translate(item.source, options.signal);
        const warning = checkTranslationQuality(item.source, text) ?? undefined;

        cache.set(key, text);
        running -= 1;
        done += 1;
        callbacks.onItem({ id: item.id, state: 'done', text, warning, attempts: attempt });
        emitProgress();
        return;
      } catch (err) {
        lastError =
          err instanceof TranslationError
            ? err
            : new TranslationError('network', err instanceof Error ? err.message : String(err));

        if (lastError.kind === 'aborted') break;
        if (!lastError.retryable || attempt === options.maxAttempts) break;

        // 退避：服务端给了 Retry-After 就听它的，否则指数退避 + 抖动
        const backoff =
          lastError.retryAfterMs ??
          options.baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
        callbacks.onItem({ id: item.id, state: 'queued', attempts: attempt });
        try {
          await sleep(backoff, options.signal);
        } catch {
          lastError = new TranslationError('aborted', '已取消');
          break;
        }
      }
    }

    running -= 1;
    if (lastError?.kind === 'aborted' || options.signal.aborted) {
      cancelled += 1;
    } else {
      failed += 1;
    }
    callbacks.onItem({
      id: item.id,
      state: 'error',
      error: lastError ?? new TranslationError('network', '未知错误'),
      attempts: options.maxAttempts,
    });
    emitProgress();
  };

  // ── 固定并发 worker 池 ──
  // 从共享游标取任务：先完成的 worker 先领下一个，
  // 不会像「切片分批」那样被最慢的那个拖住整批。
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await processOne(items[index]);
    }
  };

  const workerCount = Math.max(1, Math.min(options.concurrency, Math.max(1, total)));
  await Promise.all(Array.from({ length: workerCount }, worker));

  return {
    total,
    done,
    cached,
    failed,
    cancelled,
    cacheHitRate: total === 0 ? 0 : cached / total,
  };
}
