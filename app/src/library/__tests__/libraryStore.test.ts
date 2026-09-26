import { describe, expect, it } from 'vitest';

import { filterPapers } from '../../components/LibrarySidebar';
import { LibraryStore } from '../libraryStore';
import type { LibraryDb } from '../db';
import { normalizeMeta, type Collection, type PaperMeta } from '../types';

/** 每个用例一个全新实例（单例的持久化靠 IndexedDB，内存库里没有跨实例状态） */
function makeStore(): {
  store: LibraryStore;
  db: LibraryDb & { files: Map<string, ArrayBuffer>; collections: Map<string, Collection> };
} {
  const store = new LibraryStore();
  const db = memoryDb();
  store.useDb(db);
  return { store, db };
}

/** 内存版 LibraryDb：模拟 IndexedDB 的语义（meta/files/collections 分表） */
function memoryDb(): LibraryDb & { files: Map<string, ArrayBuffer>; collections: Map<string, Collection> } {
  const metas = new Map<string, PaperMeta>();
  const files = new Map<string, ArrayBuffer>();
  const collections = new Map<string, Collection>();
  return {
    files,
    collections,
    async listMeta() {
      return [...metas.values()];
    },
    async putMeta(meta) {
      metas.set(meta.id, meta);
    },
    async deleteMeta(id) {
      metas.delete(id);
    },
    async putFile(id, data) {
      files.set(id, data);
    },
    async getFile(id) {
      return files.get(id) ?? null;
    },
    async deleteFile(id) {
      files.delete(id);
    },
    async listCollections() {
      return [...collections.values()];
    },
    async putCollection(c) {
      collections.set(c.id, c);
    },
    async deleteCollection(id) {
      collections.delete(id);
    },
  };
}

const input = (over: Partial<Parameters<LibraryStore['add']>[0]> = {}) => ({
  title: 'A Great Paper',
  fileName: 'great.pdf',
  byteLength: 1000,
  pageCount: 42,
  data: new ArrayBuffer(1000),
  ...over,
});

describe('论文库 store', () => {
  it('入库后列表可见，最近打开的排前面', async () => {
    const { store } = makeStore();
    await store.add(input({ title: 'Old', fileName: 'a.pdf' }));
    await new Promise((r) => setTimeout(r, 5));
    await store.add(input({ title: 'New', fileName: 'b.pdf' }));

    const papers = store.getSnapshot().papers;
    expect(papers.map((p) => p.title)).toEqual(['New', 'Old']);
  });

  it('同一文件（文件名 + 字节数相同）只保留一条 —— 重复拖放不产生重复条目', async () => {
    const { store } = makeStore();
    const first = await store.add(input());
    const again = await store.add(input({ title: '改名了', pageCount: 43 }));
    expect(again.id).toBe(first.id);
    expect(store.getSnapshot().papers).toHaveLength(1);
    // 元数据被更新（页数修正、标题不改 —— 标题跟条目走）
    expect(store.getSnapshot().papers[0].pageCount).toBe(43);
    expect(store.getSnapshot().papers[0].title).toBe('A Great Paper');
  });

  it('删除会同时清掉元数据与文件', async () => {
    const { store, db } = makeStore();
    const meta = await store.add(input());
    expect(db.files.get(meta.id)).toBeDefined();

    await store.remove(meta.id);
    expect(store.getSnapshot().papers).toHaveLength(0);
    expect(db.files.has(meta.id)).toBe(false);
  });

  it('阅读进度更新后回到列表顶部', async () => {
    const { store } = makeStore();
    await store.add(input({ title: 'A', fileName: 'a.pdf' }));
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.add(input({ title: 'B', fileName: 'b.pdf' }));
    await store.setProgress(b.id, 7);

    const papers = store.getSnapshot().papers;
    expect(papers[0].title).toBe('B');
    expect(papers[0].lastPage).toBe(7);
  });

  it('进度未变化时不写库也不通知', async () => {
    const { store } = makeStore();
    const meta = await store.add(input());
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    await store.setProgress(meta.id, 1); // lastPage 初始就是 1
    expect(notified).toBe(0);
    unsubscribe();
  });

  it('快照是不可变更新 —— 订阅方拿到的引用只有变化时才变', async () => {
    const { store } = makeStore();
    const before = store.getSnapshot();
    await store.add(input());
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.papers).not.toBe(before.papers);
  });

  it('I14 之前入库（无 collectionIds / tags）读入后归一化为空数组', async () => {
    const { store, db } = makeStore();
    // 直接塞一条「旧格式」元数据，模拟升级前的库
    await db.putMeta({
      id: 'legacy-1',
      title: 'Legacy Paper',
      fileName: 'legacy.pdf',
      byteLength: 999,
      pageCount: 10,
      addedAt: 1,
      lastOpenedAt: 1,
      lastPage: 1,
    } as PaperMeta);
    await store.init();
    const p = store.getSnapshot().papers[0];
    expect(p.collectionIds).toEqual([]);
    expect(p.tags).toEqual([]);
  });
});

describe('集合（专题 / 文件夹）', () => {
  it('新建集合进入 collections 快照；同名不重复', async () => {
    const { store } = makeStore();
    const c1 = await store.createCollection('深度学习');
    const c2 = await store.createCollection('  深度学习  '); // 同名义忽略空白
    expect(c2.id).toBe(c1.id);
    expect(store.getSnapshot().collections).toHaveLength(1);
    expect(store.getSnapshot().collections[0].name).toBe('深度学习');
  });

  it('空名集合被拒绝', async () => {
    const { store } = makeStore();
    await expect(store.createCollection('   ')).rejects.toThrow();
  });

  it('重命名集合', async () => {
    const { store } = makeStore();
    const c = await store.createCollection('旧名');
    await store.renameCollection(c.id, '新名');
    expect(store.getSnapshot().collections[0].name).toBe('新名');
  });

  it('删除集合时从所有论文剥离该归属', async () => {
    const { store } = makeStore();
    const c = await store.createCollection('精读');
    const p = await store.add(input());
    await store.togglePaperCollection(p.id, c.id);
    expect(store.byId(p.id)!.collectionIds).toEqual([c.id]);

    await store.deleteCollection(c.id);
    expect(store.getSnapshot().collections).toHaveLength(0);
    expect(store.byId(p.id)!.collectionIds).toEqual([]);
  });
});

describe('论文归属与标签', () => {
  it('切换集合归属（加 / 取消）', async () => {
    const { store } = makeStore();
    const c = await store.createCollection('专题A');
    const p = await store.add(input());
    await store.togglePaperCollection(p.id, c.id);
    expect(store.byId(p.id)!.collectionIds).toEqual([c.id]);
    await store.togglePaperCollection(p.id, c.id);
    expect(store.byId(p.id)!.collectionIds).toEqual([]);
  });

  it('加标签去重；删标签', async () => {
    const { store } = makeStore();
    const p = await store.add(input());
    await store.addPaperTag(p.id, '实验');
    await store.addPaperTag(p.id, '实验'); // 重复忽略
    await store.addPaperTag(p.id, '  综述  '); // 去空白
    expect(store.byId(p.id)!.tags).toEqual(['实验', '综述']);
    await store.removePaperTag(p.id, '实验');
    expect(store.byId(p.id)!.tags).toEqual(['综述']);
  });

  it('setPaperTags 去重并去空白', async () => {
    const { store } = makeStore();
    const p = await store.add(input());
    await store.setPaperTags(p.id, ['A', 'a', ' ', 'B']);
    expect(store.byId(p.id)!.tags).toEqual(['A', 'B']);
  });
});

describe('filterPapers 纯过滤', () => {
  const papers: PaperMeta[] = [
    normalizeMeta({ id: '1', title: '深度学习综述', collectionIds: ['c1'], tags: ['综述'] }),
    normalizeMeta({ id: '2', title: 'ResNet', collectionIds: [], tags: ['Experiment', '实验'] }),
    normalizeMeta({ id: '3', title: 'GAN 入门', collectionIds: ['c1', 'c2'], tags: [] }),
  ];

  it('全部范围返回所有', () => {
    expect(filterPapers(papers, { kind: 'all' }, '').map((p) => p.id)).toEqual(['1', '2', '3']);
  });

  it('未分类只返回空归属的', () => {
    expect(filterPapers(papers, { kind: 'uncategorized' }, '').map((p) => p.id)).toEqual(['2']);
  });

  it('某集合只返回归属它的', () => {
    expect(filterPapers(papers, { kind: 'collection', id: 'c1' }, '').map((p) => p.id)).toEqual(['1', '3']);
  });

  it('搜索匹配标题', () => {
    expect(filterPapers(papers, { kind: 'all' }, 'res').map((p) => p.id)).toEqual(['2']);
  });

  it('搜索匹配标签（大小写不敏感）', () => {
    expect(filterPapers(papers, { kind: 'all' }, 'experiment').map((p) => p.id)).toEqual(['2']);
  });

  it('范围与搜索叠加', () => {
    expect(filterPapers(papers, { kind: 'collection', id: 'c1' }, '综述').map((p) => p.id)).toEqual(['1']);
  });
});
