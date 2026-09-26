import type { TranslationCachePort } from '../domain/translationScheduler';

/**
 * 基于 localStorage 的段落级翻译缓存。
 *
 * ── 为什么先落在 localStorage，而不是直接上 SQLite ──
 * 当前是浏览器原型，SQLite 要等迁到 Tauri。而缓存的收益**现在就存在**：
 * 同一篇论文重开一次、同一段重复出现（页眉页脚、方法描述的复用），
 * 都不该重新调模型 —— 既花钱又慢。
 * 接口（`TranslationCachePort`）与最终的存储层一致，将来换成 SQLite 只改实现。
 *
 * ── 容量控制 ──
 * localStorage 通常只有 5MB。一篇 100 页论文的译文约 200–400KB，
 * 几十篇就会撑满，而**撑满时的报错是静默的**（QuotaExceededError 只在写的时候抛）。
 * 所以这里做 LRU 淘汰：超出条目上限就丢掉最久未使用的。
 */

const STORAGE_PREFIX = 'paper-reader:translation:';
/** 条目上限。按平均 300 字符/条约 600KB，留足 localStorage 余量 */
const MAX_ENTRIES = 2000;
/** 单条长度上限。超过就不缓存 —— 极长的段落本身就是异常 */
const MAX_ENTRY_LENGTH = 20_000;

interface CacheEntry {
  text: string;
  /** 最近一次访问时间戳，用于 LRU 淘汰 */
  at: number;
}

export class LocalStorageTranslationCache implements TranslationCachePort {
  private readonly memory = new Map<string, CacheEntry>();
  private loaded = false;
  /** 写入计数。每写若干次才落一次盘，避免逐段写 localStorage 卡住主线程 */
  private writesSinceFlush = 0;
  private readonly flushEvery: number;

  constructor(private readonly storage: Storage | null = safeStorage(), flushEvery = 8) {
    this.flushEvery = flushEvery;
  }

  get(key: string): string | undefined {
    this.ensureLoaded();
    // 内存里有就优先用内存：命中路径不碰 localStorage，快一个数量级
    const entry = this.memory.get(key);
    if (entry) {
      entry.at = Date.now();
      return entry.text;
    }
    return undefined;
  }

  set(key: string, value: string): void {
    this.ensureLoaded();
    if (value.length > MAX_ENTRY_LENGTH) return;
    this.memory.set(key, { text: value, at: Date.now() });
    this.writesSinceFlush += 1;
    if (this.writesSinceFlush >= this.flushEvery) this.flush();
  }

  /** 立即落盘。迭代结束时、页面卸载前应当调用 */
  flush(): void {
    if (!this.storage) return;
    this.writesSinceFlush = 0;

    // 淘汰：先按 LRU 砍到上限以内
    if (this.memory.size > MAX_ENTRIES) {
      const sorted = [...this.memory.entries()].sort((a, b) => a[1].at - b[1].at);
      const dropCount = this.memory.size - MAX_ENTRIES;
      for (let i = 0; i < dropCount; i += 1) this.memory.delete(sorted[i][0]);
    }

    try {
      this.storage.setItem(STORAGE_PREFIX + '__index', this.serialize());
    } catch {
      // QuotaExceededError：再砍一半重试一次。仍失败就放弃落盘 ——
      // 缓存丢了只是慢一点，不该影响翻译本身
      try {
        const sorted = [...this.memory.entries()].sort((a, b) => a[1].at - b[1].at);
        for (let i = 0; i < Math.floor(sorted.length / 2); i += 1) {
          this.memory.delete(sorted[i][0]);
        }
        this.storage.setItem(STORAGE_PREFIX + '__index', this.serialize());
      } catch {
        /* 放弃 */
      }
    }
  }

  get size(): number {
    this.ensureLoaded();
    return this.memory.size;
  }

  clear(): void {
    this.memory.clear();
    this.storage?.removeItem(STORAGE_PREFIX + '__index');
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.storage) return;
    const raw = this.storage.getItem(STORAGE_PREFIX + '__index');
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
      for (const [key, entry] of Object.entries(parsed)) {
        if (entry && typeof entry.text === 'string') {
          this.memory.set(key, { text: entry.text, at: entry.at ?? 0 });
        }
      }
    } catch {
      // 格式损坏就当作空缓存，不要因此中断启动
      this.storage.removeItem(STORAGE_PREFIX + '__index');
    }
  }

  private serialize(): string {
    return JSON.stringify(Object.fromEntries(this.memory));
  }
}

/** localStorage 在隐私模式 / 被禁用时会抛异常，探测一次并降级为纯内存 */
function safeStorage(): Storage | null {
  try {
    const probe = '__probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}
