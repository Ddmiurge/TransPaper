/**
 * 论文库的元数据。
 *
 * ── 为什么 PDF 二进制与元数据分表存 ──
 * 侧边栏只需要标题、页数、阅读位置这些小字段 —— 列表渲染时若把
 * 几十 MB 的 PDF 一起加载，打开应用就要读完全部文件。
 * 分成 `meta` / `files` 两个 store，列表只读 meta，
 * 只有真正打开某篇时才去 files 取二进制。
 */

/** 一个集合（专题 / 文件夹）—— 论文可以按主题归入，一篇可属于多个集合 */
export interface Collection {
  /** 稳定 id。建集合时生成（crypto.randomUUID） */
  id: string;
  /** 集合名（用户填写，如「深度学习」「待精读」） */
  name: string;
  createdAt: number;
}

export interface PaperMeta {
  /** 稳定 id。入库时生成（crypto.randomUUID） */
  id: string;
  /** 侧边栏显示的标题。默认文件名去扩展名 */
  title: string;
  /** 原始文件名 */
  fileName: string;
  /** 字节数 —— 与 fileName 一起用于去重（同一文件拖两次只留一条） */
  byteLength: number;
  pageCount: number;
  addedAt: number;
  lastOpenedAt: number;
  /** 上次读到的页码（阅读位置） */
  lastPage: number;
  /** 所属集合 id 列表（可为空，表示「未分类」）。一篇可归入多个集合 */
  collectionIds: string[];
  /** 自由标签（如「精读」「实验」），用于交叉检索 */
  tags: string[];
}

/**
 * 读入旧数据时把缺省字段补成合法值 —— I14 之前入库的论文没有
 * collectionIds / tags 字段，直接读会让类型收窄失败。统一在这里兜底。
 */
export function normalizeMeta(meta: Partial<PaperMeta> & { id: string }): PaperMeta {
  return {
    id: meta.id,
    title: meta.title ?? meta.fileName ?? '未命名',
    fileName: meta.fileName ?? '',
    byteLength: meta.byteLength ?? 0,
    pageCount: meta.pageCount ?? 0,
    addedAt: meta.addedAt ?? meta.lastOpenedAt ?? Date.now(),
    lastOpenedAt: meta.lastOpenedAt ?? meta.addedAt ?? Date.now(),
    lastPage: meta.lastPage ?? 1,
    collectionIds: meta.collectionIds ?? [],
    tags: meta.tags ?? [],
  };
}
