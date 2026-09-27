import type { BlockOverride, OverrideKind } from '../domain/overrides';

/**
 * 手动改判 store（模块级单例，模式与 translationStore 一致）。
 *
 * ── 为什么按「当前文档」整体切换 ──
 * 改判锚点是「页码 + 文本前缀」，跨文档可能撞车（不同论文的第 1 页都有
 * `1|Introduction` 式块）。所以文档切换时必须整体 hydrate/reset，
 * 与 translationStore.reset() 的道理相同。
 *
 * 快照不可变 + 订阅返回稳定引用 —— 这是 useSyncExternalStore 的硬要求，
 * 也是 translationStore 踩过的坑（订阅不幂等会直接无限循环）。
 */
export interface OverrideSnapshot {
  /** 当前文档 key（论文库 id；fixture / 直接打开的文件为 null） */
  docKey: string | null;
  /** 锚点 → 改判类型（不含 auto；auto 即删除条目） */
  byAnchor: ReadonlyMap<string, OverrideKind>;
}

const EMPTY: ReadonlyMap<string, OverrideKind> = new Map();

let snapshot: OverrideSnapshot = { docKey: null, byAnchor: EMPTY };

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

export const overrideStore = {
  getSnapshot(): OverrideSnapshot {
    return snapshot;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** 切换文档并注入该文档已持久化的改判（来自 PaperMeta.overrides） */
  setDoc(docKey: string | null, persisted: BlockOverride[] = []): void {
    const byAnchor = new Map<string, OverrideKind>();
    for (const o of persisted) byAnchor.set(o.anchor, o.kind);
    snapshot = { docKey, byAnchor };
    emit();
  },

  /** 设置一条改判；`auto` 表示撤销。仅当 docKey 就绪时可用 */
  set(anchor: string, kind: OverrideKind): void {
    if (!snapshot.docKey) return;
    const next = new Map(snapshot.byAnchor);
    if (kind === 'auto') next.delete(anchor);
    else next.set(anchor, kind);
    snapshot = { ...snapshot, byAnchor: next };
    emit();
  },

  /** 当前文档的改判导出（供持久化到 PaperMeta）。auto 在 set 时已删除，这里再守一道 */
  exportOverrides(): BlockOverride[] {
    const out: BlockOverride[] = [];
    for (const [anchor, kind] of snapshot.byAnchor) {
      if (kind === 'auto') continue;
      out.push({ anchor, kind });
    }
    return out;
  },
};
