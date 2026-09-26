import { normalizeMeta, type Collection, type PaperMeta } from './types';

/**
 * 论文库的存储接口。
 *
 * ── 为什么做成接口而不是直接用 IndexedDB ──
 * libraryStore 的列表管理逻辑（去重、排序、快照更新）是**纯逻辑**，
 * 必须能脱离浏览器在 Node 里测试。把「字节落到哪里」收进这个接口，
 * 测试注入内存实现，生产注入 IndexedDB 实现。
 */
export interface LibraryDb {
  listMeta(): Promise<PaperMeta[]>;
  putMeta(meta: PaperMeta): Promise<void>;
  deleteMeta(id: string): Promise<void>;
  putFile(id: string, data: ArrayBuffer): Promise<void>;
  getFile(id: string): Promise<ArrayBuffer | null>;
  deleteFile(id: string): Promise<void>;
  /** I14：集合分表 */
  listCollections(): Promise<Collection[]>;
  putCollection(c: Collection): Promise<void>;
  deleteCollection(id: string): Promise<void>;
}

const DB_NAME = 'paper-library';
const DB_VERSION = 2;
const META_STORE = 'meta';
const FILE_STORE = 'files';
const COLLECTION_STORE = 'collections';

/** 用 Promise 包一层 IndexedDB 的请求回调，调用侧就能写顺序逻辑 */
function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

export class IdbLibraryDb implements LibraryDb {
  private readonly db: Promise<IDBDatabase>;

  constructor() {
    this.db = new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        // meta 以 id 为主键；files 是二进制，用 id 作外置 key；
        // collections 以 id 为主键（v2 新增）。
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(FILE_STORE)) {
          db.createObjectStore(FILE_STORE);
        }
        if (!db.objectStoreNames.contains(COLLECTION_STORE)) {
          db.createObjectStore(COLLECTION_STORE, { keyPath: 'id' });
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error('无法打开论文库数据库'));
    });
  }

  private async store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.db;
    // 每次操作独立事务 —— 长事务会阻塞其它读写，且容易因为忘提交而丢数据
    return db.transaction(name, mode).objectStore(name);
  }

  async listMeta(): Promise<PaperMeta[]> {
    const rows = (await wrap(
      (await this.store(META_STORE, 'readonly')).getAll() as IDBRequest<Partial<PaperMeta>[]>
    )) as Partial<PaperMeta>[];
    // 读入时归一化 —— I14 之前入库的论文没有 collectionIds / tags
    return rows.map((r) => normalizeMeta(r as Partial<PaperMeta> & { id: string }));
  }

  async putMeta(meta: PaperMeta): Promise<void> {
    await wrap((await this.store(META_STORE, 'readwrite')).put(meta));
  }

  async deleteMeta(id: string): Promise<void> {
    await wrap((await this.store(META_STORE, 'readwrite')).delete(id));
  }

  async putFile(id: string, data: ArrayBuffer): Promise<void> {
    await wrap((await this.store(FILE_STORE, 'readwrite')).put(data, id));
  }

  async getFile(id: string): Promise<ArrayBuffer | null> {
    const result = await wrap(
      (await this.store(FILE_STORE, 'readonly')).get(id) as IDBRequest<ArrayBuffer | undefined>
    );
    return result ?? null;
  }

  async deleteFile(id: string): Promise<void> {
    await wrap((await this.store(FILE_STORE, 'readwrite')).delete(id));
  }

  async listCollections(): Promise<Collection[]> {
    return wrap(
      (await this.store(COLLECTION_STORE, 'readonly')).getAll() as IDBRequest<Collection[]>
    );
  }

  async putCollection(c: Collection): Promise<void> {
    await wrap((await this.store(COLLECTION_STORE, 'readwrite')).put(c));
  }

  async deleteCollection(id: string): Promise<void> {
    await wrap((await this.store(COLLECTION_STORE, 'readwrite')).delete(id));
  }
}
