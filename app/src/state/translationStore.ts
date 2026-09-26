import { useCallback, useRef, useSyncExternalStore } from 'react';

import {
  DEFAULT_TRANSLATION_CONFIG,
  type TranslationConfig,
} from '../domain/translation';
import {
  runTranslation,
  type SchedulerResult,
  type TranslationItemStatus,
} from '../domain/translationScheduler';
import { LocalStorageTranslationCache } from '../infra/translationCache';
import { OpenAICompatibleTranslator } from '../infra/openaiCompatible';
import { loadSettings } from './translationSettings';

/**
 * 译文仓库（模块级单例）。
 *
 * ── 为什么是模块级，而不是 React context ──
 * 瀑布流下每一页是一个独立的 `PageFlowBlock`，各自解析、各自渲染。
 * 译文却必须跨页共享（连点两次翻译只译新出现的段落、已译段落复用）。
 * 用 context 也行，但 context 的值一变，所有页面都会重渲染 ——
 * 而译文是**逐段到达**的（一段完成就回填一次），那会导致整篇反复重渲染。
 *
 * 单例 store + `useSyncExternalStore` 的粒度控制更细：
 * 只有快照对象变了才通知，且页面组件可以只订阅自己需要的切片。
 */

export type TranslationRunStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'failed';

export interface TranslationProgress {
  total: number;
  done: number;
  cached: number;
  failed: number;
  running: number;
}

export interface TranslationSnapshot {
  status: TranslationRunStatus;
  /** blockId → 译文 */
  byBlockId: ReadonlyMap<string, string>;
  /** blockId → 质量告警 */
  warnings: ReadonlyMap<string, string>;
  /** 失败明细，按出现顺序 */
  errors: readonly { id: string; message: string; source: string }[];
  progress: TranslationProgress;
  /** 已注册（等待翻译）的段落总数 */
  registered: number;
  /** 最近一次运行的结果，用于面板展示命中率 */
  lastResult: SchedulerResult | null;
  /** 面向用户的一句话状态 */
  message: string | null;
}

const EMPTY_PROGRESS: TranslationProgress = { total: 0, done: 0, cached: 0, failed: 0, running: 0 };

type Listener = () => void;

class TranslationStore {
  private snapshot: TranslationSnapshot = {
    status: 'idle',
    byBlockId: new Map(),
    warnings: new Map(),
    errors: [],
    progress: EMPTY_PROGRESS,
    registered: 0,
    lastResult: null,
    message: null,
  };

  private readonly listeners = new Set<Listener>();
  /** blockId → 原文。**跨运行保留** —— 重新点翻译时只处理新段落 */
  private readonly sources = new Map<string, string>();
  private readonly cache = new LocalStorageTranslationCache();
  private abort: AbortController | null = null;
  /** 防止并发触发（用户连点两次「一键翻译」） */
  private busy = false;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getSnapshot = (): TranslationSnapshot => this.snapshot;

  /**
   * 注册待翻译的段落。**幂等** —— 同一 blockId 重复注册不会产生副作用。
   *
   * 幂等这一条是硬要求：页面在缩放切换、重渲染时都会重新注册，
   * 若不幂等，`registered` 会不断增长、快照不断更新，
   * 而快照更新又会触发重渲染 —— 直接进入无限循环。
   */
  register(blocks: Array<{ id: string; text: string }>): void {
    let added = 0;
    for (const block of blocks) {
      if (!block.text.trim()) continue;
      if (this.sources.has(block.id)) continue;
      this.sources.set(block.id, block.text);
      added += 1;
    }
    if (added === 0) return;
    this.patch({ registered: this.sources.size });
  }

  /** 已译/待译的段落数（含未翻译的） */
  get sourceCount(): number {
    return this.sources.size;
  }

  /**
   * 开始翻译。只处理「还没有译文」的段落 ——
   * 所以重复点击是安全的，且第二次点几乎零成本（全部命中缓存）。
   */
  async start(): Promise<void> {
    if (this.busy) return;

    const settings = loadSettings();
    const pending = [...this.sources.entries()].filter(([id]) => !this.snapshot.byBlockId.has(id));

    if (pending.length === 0) {
      this.patch({
        status: 'done',
        message:
          this.sources.size === 0
            ? '还没有可翻译的段落 —— 先让页面加载出来'
            : '所有已加载的段落都已翻译完成',
      });
      return;
    }

    this.busy = true;
    this.abort = new AbortController();

    const config: TranslationConfig = {
      ...DEFAULT_TRANSLATION_CONFIG,
      provider: settings.provider,
      model: settings.model,
    };

    const port = new OpenAICompatibleTranslator({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
    });

    const byBlockId = new Map(this.snapshot.byBlockId);
    const warnings = new Map(this.snapshot.warnings);
    const errors: { id: string; message: string; source: string }[] = [];

    const patchThrottle = this.makeProgressPatcher(pending.length);
    this.patch({
      status: 'running',
      message: `正在翻译 ${pending.length} 段…`,
      progress: { total: pending.length, done: 0, cached: 0, failed: 0, running: 0 },
    });

    const onItem = (status: TranslationItemStatus) => {
      if (status.text !== undefined) byBlockId.set(status.id, status.text);
      if (status.warning) warnings.set(status.id, status.warning);

      if (status.state === 'error') {
        errors.push({
          id: status.id,
          message: status.error?.message ?? '未知错误',
          source: this.sources.get(status.id)?.slice(0, 60) ?? '',
        });
      }

      // 译文逐段回填：每段完成就更新快照，用户立刻看到内容
      if (status.state === 'done' || status.state === 'cached') {
        this.patch({
          byBlockId: new Map(byBlockId),
          warnings: new Map(warnings),
        });
      }
    };

    try {
      const result = await runTranslation(
        pending.map(([id, source]) => ({ id, source })),
        { port, cache: this.cache },
        { onItem, onProgress: (p) => patchThrottle(p, byBlockId, warnings, errors) },
        {
          config,
          concurrency: settings.concurrency,
          maxAttempts: settings.maxAttempts,
          baseDelayMs: settings.baseDelayMs,
          signal: this.abort.signal,
        }
      );

      this.cache.flush();

      const cancelled = result.cancelled > 0 || this.abort.signal.aborted;
      this.patch({
        status: cancelled ? 'cancelled' : result.failed > 0 ? 'failed' : 'done',
        byBlockId: new Map(byBlockId),
        warnings: new Map(warnings),
        errors: [...errors],
        lastResult: result,
        progress: {
          total: result.total,
          done: result.done,
          cached: result.cached,
          failed: result.failed,
          running: 0,
        },
        message: this.summarize(result, cancelled),
      });
    } catch (err) {
      // 走到这里说明是调度器自身的意外（正常失败都在 onItem 里汇报了）
      this.patch({
        status: 'failed',
        message: `翻译中断：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  cancel(): void {
    this.abort?.abort();
    this.patch({ message: '正在取消…' });
  }

  /**
   * 打开**新文档**时重置。
   *
   * ── 为什么必须调用 ──
   * 块 id 是 `p{页}-c{栏}-b{序}`，**不含内容**（见 paragraphBuilder 的 makeBlock）。
   * 于是另一篇论文的第 1 页第 1 栏第 1 段也叫 `p0-c0-b0` —— 若不重置，
   * 新文档会直接把旧文档的译文显示出来。这个 bug 在「只能加载内置样本」时永远不会暴露，
   * 一旦支持打开文件就会立刻出现。
   *
   * 缓存**不清**：它按原文哈希索引，换文档后依然有效 ——
   * 重新打开同一篇论文时译文会立刻从缓存回填，这是期望行为。
   */
  reset(): void {
    if (this.busy) return;
    this.sources.clear();
    this.patch({
      status: 'idle',
      byBlockId: new Map(),
      warnings: new Map(),
      errors: [],
      progress: EMPTY_PROGRESS,
      registered: 0,
      lastResult: null,
      message: null,
    });
  }

  /** 清空译文（不影响缓存）—— 用于切换模型后重新翻译 */
  clearTranslations(): void {
    if (this.busy) return;
    this.patch({
      status: 'idle',
      byBlockId: new Map(),
      warnings: new Map(),
      errors: [],
      progress: EMPTY_PROGRESS,
      lastResult: null,
      message: '已清空译文。重新点击翻译会命中缓存（除非换了模型）',
    });
  }

  /**
   * 进度回调的节流。
   *
   * 逐段触发 `onProgress` 时，若每次都新建快照，100 段就是 100 次全量重渲染 ——
   * 瀑布流下每一页都要重建 PageFlow，代价可观。
   * 这里让进度**最多每 120ms 更新一次**，但「有译文到达」的更新不受节流影响
   * （那条路径由 onItem 直接触发），保证用户能立刻看到内容出现。
   */
  private makeProgressPatcher(total: number) {
    let lastAt = 0;
    return (
      p: TranslationProgress,
      byBlockId: Map<string, string>,
      warnings: Map<string, string>,
      errors: { id: string; message: string; source: string }[]
    ) => {
      const now = Date.now();
      const finished = p.done + p.failed >= total;
      if (!finished && now - lastAt < 120) return;
      lastAt = now;
      this.patch({
        progress: { ...p },
        byBlockId: new Map(byBlockId),
        warnings: new Map(warnings),
        errors: [...errors],
      });
    };
  }

  private summarize(result: SchedulerResult, cancelled: boolean): string {
    const parts: string[] = [];
    if (cancelled) parts.push('已取消');
    parts.push(`完成 ${result.done}/${result.total} 段`);
    if (result.cached > 0) parts.push(`其中 ${result.cached} 段命中缓存`);
    if (result.failed > 0) parts.push(`${result.failed} 段失败`);
    if (result.failed === 0 && !cancelled) {
      parts.push(result.cacheHitRate > 0.5 ? '（大部分来自缓存，未额外计费）' : '');
    }
    return parts.filter(Boolean).join('，');
  }

  private patch(next: Partial<TranslationSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }
}

export const translationStore = new TranslationStore();

/** 订阅整个快照 */
export function useTranslation(): TranslationSnapshot {
  return useSyncExternalStore(translationStore.subscribe, translationStore.getSnapshot);
}

/**
 * 只订阅**某几个块**的译文。
 *
 * ── 为什么不能直接用 useTranslation() ──
 * 译文是逐段到达的（一段完成回填一次）。若每一页都订阅整个快照，
 * 翻译 150 段就是 150 次「全部已加载页重建文档流」——
 * 而重建文档流包含按 bbox 裁切 canvas，是这一层最贵的操作。
 * 12 页 × 150 次 = 1800 次重绘，瀑布流会明显卡顿。
 *
 * 这里做的是「按 key 集合做细粒度订阅」：只有当**这一页关心的 key**
 * 的译文发生变化时，才返回新的 Map（引用变化），从而只重渲染该页。
 *
 * 实现上必须保证 getSnapshot 返回**稳定引用**（React 会校验），
 * 所以用 ref 缓存上一次的结果，并逐个 key 比对值。
 */
export function useTranslationsFor(keys: readonly string[]): ReadonlyMap<string, string> {
  const signature = keys.join('\u0001');
  const keysRef = useRef<readonly string[]>(keys);
  keysRef.current = keys;

  const memo = useRef<{ signature: string; snapshot: Map<string, string> } | null>(null);
  const sigRef = useRef(signature);
  sigRef.current = signature;

  const getSnapshot = useCallback(() => {
    const current = translationStore.getSnapshot().byBlockId;
    const prev = memo.current;
    const sig = sigRef.current;

    // 快路径：key 集合没变，且这些 key 的值都没变 → 返回上次的对象（引用不变）
    if (prev && prev.signature === sig) {
      let changed = false;
      for (const key of keysRef.current) {
        if (prev.snapshot.get(key) !== current.get(key)) {
          changed = true;
          break;
        }
      }
      if (!changed) return prev.snapshot;
    }

    const next = new Map<string, string>();
    for (const key of keysRef.current) {
      const value = current.get(key);
      if (value !== undefined) next.set(key, value);
    }
    memo.current = { signature: sig, snapshot: next };
    return next;
  }, []);

  return useSyncExternalStore(translationStore.subscribe, getSnapshot);
}

