import { isDesktop, logLine } from '../infra/desktopLog';
import { IdbLibraryDb, type LibraryDb } from './db';
import { migrateLegacyIdbToSqlite, TauriLibraryDb } from './sqliteDb';
import { normalizeMeta, type Collection, type PaperMeta } from './types';
import type { BlockOverride } from '../domain/overrides';

/**
 * 论文库 store（模块级单例，模式与 translationStore 一致）。
 *
 * ── 状态最小化 ──
 * 快照里只有元数据列表与集合列表。PDF 二进制**不进快照**（几十 MB，进了就废掉
 * 引用相等性检查），按需经 getFileData 取。
 */
export interface LibrarySnapshot {
  /** IndexedDB 首次加载是否完成。完成前侧边栏显示加载态 */
  loaded: boolean;
  /** 按最近打开时间倒序 */
  papers: readonly PaperMeta[];
  /** 全部集合（按创建时间） */
  collections: readonly Collection[];
}

type Listener = () => void;

export interface AddPaperInput {
  title: string;
  fileName: string;
  byteLength: number;
  pageCount: number;
  data: ArrayBuffer;
}

export class LibraryStore {
  private snapshot: LibrarySnapshot = { loaded: false, papers: [], collections: [] };
  private readonly listeners = new Set<Listener>();
  /**
   * 惰性创建 —— **不能**在字段初始化时创建 db：
   * 那会立刻打开 IndexedDB，而 Node 测试环境里没有 indexedDB 全局，
   * 就算测试随后注入内存实现，构造期的拒绝也已经逃逸成 unhandled rejection。
   * 只有真正 init()/读写时才创建。
   * 桌面环境用 SQLite（I23），浏览器用 IndexedDB，接口相同。
   */
  private db: LibraryDb | null = null;
  /** 防止 init 被多次触发 */
  private initPromise: Promise<void> | null = null;

  private get database(): LibraryDb {
    return (this.db ??= isDesktop() ? new TauriLibraryDb() : new IdbLibraryDb());
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getSnapshot = (): LibrarySnapshot => this.snapshot;

  private patch(partial: Partial<LibrarySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) listener();
  }

  /** 测试注入内存实现用 */
  useDb(db: LibraryDb): void {
    this.db = db;
  }

  init(): Promise<void> {
    this.initPromise ??= (async () => {
      try {
        // I23：桌面首次跑 SQLite 版时，把 IndexedDB 里的旧数据搬过来
        if (isDesktop() && this.database instanceof TauriLibraryDb) {
          const migrated = await migrateLegacyIdbToSqlite(this.database);
          if (migrated > 0) logLine(`library migrated: ${migrated} papers from IndexedDB to SQLite`);
        }
        const [rawMetas, collections] = await Promise.all([
          this.database.listMeta(),
          this.database.listCollections(),
        ]);
        // 读入即归一化 —— I14 之前入库的论文没有 collectionIds / tags，
        // 不论后端是否已在 listMeta 里兜底，这里再保险一次。
        const metas = rawMetas.map((m) => normalizeMeta(m));
        metas.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
        collections.sort((a, b) => a.createdAt - b.createdAt);
        this.patch({ loaded: true, papers: metas, collections });
      } catch {
        // 存储不可用（隐私模式等）不应白屏 —— 论文库降级为不可用，阅读器照常
        this.patch({ loaded: true, papers: [], collections: [] });
      }
    })();
    return this.initPromise;
  }

  /**
   * 入库。同一文件（fileName + byteLength 相同）只保留一条 ——
   * 用户把同一个 PDF 拖两次不应该得到两个条目。
   */
  async add(input: AddPaperInput): Promise<PaperMeta> {
    await this.init();
    const existing = this.snapshot.papers.find(
      (p) => p.fileName === input.fileName && p.byteLength === input.byteLength
    );
    const now = Date.now();
    const meta: PaperMeta = existing
      ? normalizeMeta({ ...existing, pageCount: input.pageCount, lastOpenedAt: now })
      : normalizeMeta({
          id: crypto.randomUUID(),
          title: input.title,
          fileName: input.fileName,
          byteLength: input.byteLength,
          pageCount: input.pageCount,
          addedAt: now,
          lastOpenedAt: now,
          lastPage: 1,
        });

    await this.database.putMeta(meta);
    await this.database.putFile(meta.id, input.data);
    this.patch({
      papers: [meta, ...this.snapshot.papers.filter((p) => p.id !== meta.id)],
    });
    return meta;
  }

  async remove(id: string): Promise<void> {
    await this.database.deleteMeta(id);
    await this.database.deleteFile(id);
    this.patch({ papers: this.snapshot.papers.filter((p) => p.id !== id) });
  }

  /** 更新阅读进度。翻页频繁，写 IndexedDB 很便宜，不做防抖 */
  async setProgress(id: string, page: number): Promise<void> {
    const current = this.snapshot.papers.find((p) => p.id === id);
    if (!current || current.lastPage === page) return;
    const meta: PaperMeta = normalizeMeta({ ...current, lastPage: page, lastOpenedAt: Date.now() });
    await this.database.putMeta(meta);
    this.patch({
      papers: [meta, ...this.snapshot.papers.filter((p) => p.id !== id)],
    });
  }

  async getFileData(id: string): Promise<ArrayBuffer | null> {
    return this.database.getFile(id);
  }

  /** 最近打开的一篇（用于启动恢复） */
  lastOpened(): PaperMeta | null {
    return this.snapshot.papers[0] ?? null;
  }

  byId(id: string): PaperMeta | null {
    return this.snapshot.papers.find((p) => p.id === id) ?? null;
  }

  // ─────────────────────────────────────────────────────────────
  // 集合（专题 / 文件夹）
  // ─────────────────────────────────────────────────────────────

  /** 新建集合。同名（忽略首尾空白）不重复创建，返回已存在的那一个 */
  async createCollection(name: string): Promise<Collection> {
    await this.init();
    const trimmed = name.trim();
    if (!trimmed) throw new Error('集合名不能为空');
    const existed = this.snapshot.collections.find(
      (c) => c.name.trim().toLowerCase() === trimmed.toLowerCase()
    );
    if (existed) return existed;
    const collection: Collection = {
      id: crypto.randomUUID(),
      name: trimmed,
      createdAt: Date.now(),
    };
    await this.database.putCollection(collection);
    this.patch({ collections: [...this.snapshot.collections, collection] });
    return collection;
  }

  async renameCollection(id: string, name: string): Promise<void> {
    const current = this.snapshot.collections.find((c) => c.id === id);
    if (!current) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const updated: Collection = { ...current, name: trimmed };
    await this.database.putCollection(updated);
    this.patch({
      collections: this.snapshot.collections.map((c) => (c.id === id ? updated : c)),
    });
  }

  /**
   * 删除集合。同时把它从所有论文的 collectionIds 里剥离 ——
   * 否则会出现「指向已删除集合的孤儿引用」，导航过滤时匹配不到、论文凭空消失。
   */
  async deleteCollection(id: string): Promise<void> {
    await this.database.deleteCollection(id);
    const affected = this.snapshot.papers.filter((p) => p.collectionIds.includes(id));
    for (const p of affected) {
      const cleaned = normalizeMeta({
        ...p,
        collectionIds: p.collectionIds.filter((c) => c !== id),
      });
      await this.database.putMeta(cleaned);
    }
    this.patch({
      collections: this.snapshot.collections.filter((c) => c.id !== id),
      papers: this.snapshot.papers.map((p) =>
        affected.some((a) => a.id === p.id)
          ? normalizeMeta({ ...p, collectionIds: p.collectionIds.filter((c) => c !== id) })
          : p
      ),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 论文 ↔ 集合 归属 / 标签
  // ─────────────────────────────────────────────────────────────

  /** 切换论文是否属于某集合（菜单里勾选/取消勾选用） */
  async togglePaperCollection(paperId: string, collectionId: string): Promise<void> {
    const current = this.snapshot.papers.find((p) => p.id === paperId);
    if (!current) return;
    const has = current.collectionIds.includes(collectionId);
    const collectionIds = has
      ? current.collectionIds.filter((c) => c !== collectionId)
      : [...current.collectionIds, collectionId];
    await this.persistPaper({ ...current, collectionIds });
  }

  /** 覆盖该论文的全部标签（去重、去空白、保序） */
  async setPaperTags(paperId: string, tags: string[]): Promise<void> {
    const current = this.snapshot.papers.find((p) => p.id === paperId);
    if (!current) return;
    const cleaned = dedupeTags(tags);
    if (sameTags(cleaned, current.tags)) return;
    await this.persistPaper({ ...current, tags: cleaned });
  }

  /**
   * 写回块类型手动改判（I18）。全量替换：改判条目很少（一篇通常个位数），
   * 全量写比增删改简单且不会出现部分写坏的状态。
   * 同锚点重复改判由调用方先去重（后写覆盖先写）。
   */
  async setOverrides(paperId: string, overrides: BlockOverride[]): Promise<void> {
    const current = this.snapshot.papers.find((p) => p.id === paperId);
    if (!current) return;
    if (JSON.stringify(current.overrides) === JSON.stringify(overrides)) return;
    await this.persistPaper({ ...current, overrides });
  }

  /** 给论文加一个标签（已存在则忽略） */
  async addPaperTag(paperId: string, tag: string): Promise<void> {
    const current = this.snapshot.papers.find((p) => p.id === paperId);
    if (!current) return;
    const trimmed = tag.trim();
    if (!trimmed || current.tags.includes(trimmed)) return;
    await this.persistPaper({ ...current, tags: [...current.tags, trimmed] });
  }

  /** 移除一个标签 */
  async removePaperTag(paperId: string, tag: string): Promise<void> {
    const current = this.snapshot.papers.find((p) => p.id === paperId);
    if (!current) return;
    const tags = current.tags.filter((t) => t !== tag);
    if (tags.length === current.tags.length) return;
    await this.persistPaper({ ...current, tags });
  }

  /** 写回单篇论文的元数据并刷新快照（保持最近打开倒序） */
  private async persistPaper(meta: PaperMeta): Promise<void> {
    const normalized = normalizeMeta(meta);
    await this.database.putMeta(normalized);
    // 不改变阅读顺序（lastOpenedAt 不变），只在原位替换
    this.patch({
      papers: this.snapshot.papers.map((p) => (p.id === normalized.id ? normalized : p)),
    });
  }
}

/** 标签去重（精确匹配，忽略空白与大小写归一后的重复项，保留首次出现顺序） */
function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const lower = new Set(a.map((t) => t.toLowerCase()));
  return b.every((t) => lower.has(t.toLowerCase()));
}

export const libraryStore = new LibraryStore();
