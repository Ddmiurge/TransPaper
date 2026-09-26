# I14 小结 · 论文库：集合 + 标签（R2 完整形态）

> 迭代日期：2026-09-26 · 样本：`fixtures/two-column-sample.pdf`（ResNet，端到端验证用）
> 触发：计划内下一阶段（I13 小结「下一迭代候选」第 1 项）。用户上一轮确认"按
> 计划进行下一个阶段的迭代"，R2 落地（I12）之后只差"按主题归类"这一块。

## 目标

I12 让"论文库"能存（IndexedDB 持久化）、能找（列表 / 搜索 / 删除），但论文仍是
**平铺的一长条**——没法按研究方向、课程、阅读状态归类。一个真正可用的文献管理
必须支持**集合（专题 / 文件夹）**与**标签**。本迭代补上。

## 方案

### 数据模型（`library/types.ts`）

- 新增 `Collection { id, name, createdAt }`；
- `PaperMeta` 增加 `collectionIds: string[]` 与 `tags: string[]`；
- **向后兼容**：`normalizeMeta` 把缺这两个字段的旧条目（I12 之前入库的）兜底
  成空数组，读入即归一化，双保险（store 的 `init` 也再归一一次）。

### 存储层（`library/db.ts`）

- IndexedDB 升 `DB_VERSION = 2`，onupgradeneeded 里新建 `collections` 对象库；
- `LibraryDb` 接口新增 `listCollections / putCollection / deleteCollection`，
  内存实现与 IdbLibraryDb 同步补齐。

### Store（`library/libraryStore.ts`）

- 集合生命周期：`createCollection`（同名忽略大小写不重复）、`renameCollection`、
  `deleteCollection`；
- **删集合剥离归属**：删集合时遍历所有论文把它的 id 从 `collectionIds` 摘掉并
  回写，否则留下"指向已删集合的孤儿引用"——导航过滤时匹配不到，论文凭空消失；
- 论文归属 / 标签：`togglePaperCollection`（菜单勾选 / 取消）、`setPaperTags`、
  `addPaperTag`（已存在忽略）、`removePaperTag`；
- 标签去重（精确 + 大小写归一，保序）；快照带 `collections`。

### 侧边栏 UI（`LibrarySidebar.tsx`）

- 顶部导航：**全部 / 各集合(带计数) / 未分类**，按主题过滤列表；
- 每条论文显示**标签 chips**，提供「⋯」分配菜单：勾选归属集合 + 增删标签；
- 底部「新建集合」输入；
- 搜索**同时覆盖标题与标签**（contains，大小写不敏感）；
- 纯过滤逻辑 `filterPapers(papers, scope, query)` 抽出来单测。

## 关键决策

1. **新建集合后不自动切到该集合视图**。最初的实现会 `setScopeKeyState(c:id)`
   切过去，但新建的集合此刻是空的——列表立刻变空、条目菜单消失，用户反而没法
   给现有论文归类。改为留在当前视图（通常是"全部"），用户打开菜单即可勾选。
   这一条是被端到端验证逼出来的：step 3 找不到 `.library-item-menu` 才暴露。
2. 删集合采用"先按 id 摘论文、再删集合"的强一致写法，避免孤儿引用。

## 效果（截图 `artifacts/i14-sidebar.png`）

- 侧边栏从"平铺列表"升级为"可分类的文献库"：导航按集合过滤、论文带标签；
- 入库 → 建集合 → 归属 → 打标签 → 按集合过滤 → 刷新后持久化（IndexedDB）全链跑通。

## 验证

- 单测：13 → **13 文件 / 150 用例**（+14：集合生命周期 5、归属剥离 2、标签
  增删 4、filterPapers 3）；
- 类型检查 0 错误 · 构建正常；
- **三基线无回归**：双栏 ResNet、单栏 42 页、ACL 17 页；
- **端到端（无头 Edge + CDP）**：`scripts/verify-library.mjs` 驱动真实
  DOM——经文件输入入库、原生输入法建集合、分配菜单勾选 + 加标签、切集合过滤、
  整页刷新验证持久化，全过并截图。

## 遗留

- 集合改名 UI 未做（只有删除）；标签目前无全局标签云 / 标签下过滤；
- 拖拽论文到集合、集合拖拽排序未做；
- 标题仍取自文件名（PDF 元数据 / 首页标题提取仍是 I15 候选）；
- 旧 `setScopeKeyState` 自动切换视图已移除，若日后想要"建完即聚焦该集合"可加
  一个非阻塞的瞬时提示而非强制切换。
