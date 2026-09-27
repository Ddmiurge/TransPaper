import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { libraryStore } from '../library/libraryStore';
import type { PaperMeta } from '../library/types';

interface Props {
  /** 当前打开的论文 id —— 列表里高亮它 */
  currentId: string | null;
  onOpen: (meta: PaperMeta) => void;
  /** 删除由 App 处理 —— 删掉正在读的那篇时要切换文档 */
  onDelete: (meta: PaperMeta) => void;
}

/** 侧边栏的过滤范围：全部 / 某集合 / 未分类 */
type Scope = { kind: 'all' } | { kind: 'collection'; id: string } | { kind: 'uncategorized' };

const ALL: Scope = { kind: 'all' };

/** 把范围转成稳定 key（受控 UI 用） */
function scopeKey(s: Scope): string {
  return s.kind === 'collection' ? `c:${s.id}` : s.kind;
}

function scopeFromKey(key: string): Scope {
  return key.startsWith('c:') ? { kind: 'collection', id: key.slice(2) } : key === 'uncategorized' ? { kind: 'uncategorized' } : ALL;
}

/**
 * 纯过滤逻辑（抽出来单测）。
 * 先按范围收窄，再按搜索词（标题或任一标签，大小写不敏感）过滤。
 */
export function filterPapers(
  papers: readonly PaperMeta[],
  scope: Scope,
  query: string
): PaperMeta[] {
  const scoped = papers.filter((p) => {
    if (scope.kind === 'all') return true;
    if (scope.kind === 'uncategorized') return p.collectionIds.length === 0;
    return p.collectionIds.includes(scope.id);
  });
  const q = query.trim().toLowerCase();
  if (!q) return scoped;
  return scoped.filter(
    (p) =>
      p.title.toLowerCase().includes(q) ||
      p.tags.some((t) => t.toLowerCase().includes(q))
  );
}

/** 某集合下的论文数 */
function countInScope(papers: readonly PaperMeta[], scope: Scope): number {
  if (scope.kind === 'all') return papers.length;
  if (scope.kind === 'uncategorized') return papers.filter((p) => p.collectionIds.length === 0).length;
  return papers.filter((p) => p.collectionIds.includes(scope.id)).length;
}

/** 把时间戳排成「昨天 / 3 天前 / 9-12」这种一眼能懂的形式 */
function relativeDay(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/**
 * 左侧论文库侧边栏（R2）。
 *
 * ── 交互的三个决定 ──
 * 1. **点条目即打开**，没有多余的「打开」按钮 —— 列表项本身就是按钮；
 * 2. **删除是两步确认**（垃圾桶 → 变成「确认删除」）而不是 window.confirm：
 *    原生弹窗在无头验证里点不了，而且会打断心流；3 秒不确认自动还原；
 * 3. **搜索覆盖标题 + 标签**（contains，大小写不敏感）。
 *
 * ── I14 新增 ──
 * 4. 顶部「全部 / 各集合(带计数) / 未分类」导航，按主题过滤列表；
 * 5. 每条论文显示标签 chips，并提供「⋯」分配菜单：勾选归属集合、增删标签；
 * 6. 底部「新建集合」输入。
 */
export function LibrarySidebar({ currentId, onOpen, onDelete }: Props) {
  const { loaded, papers, collections } = useSyncExternalStore(
    libraryStore.subscribe,
    libraryStore.getSnapshot
  );
  const [query, setQuery] = useState('');
  const [scopeKeyState, setScopeKeyState] = useState('all');
  /** 两步确认删除的条目 id */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  /** 分配菜单打开的条目 id（同一时刻只能一个） */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** 新建集合输入框 */
  const [newColl, setNewColl] = useState('');
  /** 正在改名的集合 id（I20）—— 内联编辑，不需要弹窗 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const commitRename = async () => {
    const id = renamingId;
    const name = renameValue.trim();
    setRenamingId(null);
    setRenameValue('');
    if (!id || !name) return;
    await libraryStore.renameCollection(id, name);
  };

  const scope = useMemo(() => scopeFromKey(scopeKeyState), [scopeKeyState]);

  const visible = useMemo(
    () => filterPapers(papers, scope, query),
    [papers, scope, query]
  );

  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuFor) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuFor(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuFor]);

  const createCollection = async () => {
    const name = newColl.trim();
    if (!name) return;
    await libraryStore.createCollection(name);
    setNewColl('');
    // 不自动切到新集合视图 —— 新建的集合此刻是空的，切过去反而让用户没法给
    // 现有论文归类。留在当前视图（通常是「全部」），用户打开菜单即可勾选。
  };

  const scopes: Scope[] = useMemo(
    () => [ALL, ...collections.map((c) => ({ kind: 'collection' as const, id: c.id })), { kind: 'uncategorized' }],
    [collections]
  );

  return (
    <aside className="library">
      <div className="library-head">
        <span className="library-title">论文库</span>
        <span className="library-count">{papers.length}</span>
      </div>

      <input
        className="library-search"
        type="search"
        placeholder="搜索标题或标签…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {/* 集合导航 */}
      <nav className="library-nav">
        {scopes.map((s) => {
          const key = scopeKey(s);
          const label =
            s.kind === 'all'
              ? '全部'
              : s.kind === 'uncategorized'
                ? '未分类'
                : collections.find((c) => c.id === s.id)?.name ?? '（已删除）';
          const active = key === scopeKeyState;
          return (
            <button
              key={key}
              type="button"
              className={`library-nav-item${active ? ' is-active' : ''}`}
              onClick={() => setScopeKeyState(key)}
            >
              {/* 改名：内联输入，回车提交 / Esc 取消（I20） */}
              {s.kind === 'collection' && renamingId === s.id ? (
                <input
                  className="library-nav-rename"
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') void commitRename();
                    if (e.key === 'Escape') {
                      setRenamingId(null);
                      setRenameValue('');
                    }
                  }}
                />
              ) : (
                <span className="library-nav-label">{label}</span>
              )}
              <span className="library-nav-count">{countInScope(papers, s)}</span>
              {s.kind === 'collection' && renamingId !== s.id && (
                <span
                  role="button"
                  tabIndex={0}
                  title="重命名集合"
                  className="library-nav-rename-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingId(s.id);
                    setRenameValue(label);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setRenamingId(s.id);
                      setRenameValue(label);
                    }
                  }}
                >
                  ✎
                </span>
              )}
              {s.kind === 'collection' && (
                <span
                  role="button"
                  tabIndex={0}
                  title="删除集合"
                  className="library-nav-del"
                  onClick={(e) => {
                    e.stopPropagation();
                    void libraryStore.deleteCollection(s.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void libraryStore.deleteCollection(s.id);
                  }}
                >
                  ×
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {!loaded ? (
        <div className="library-empty">加载中…</div>
      ) : visible.length === 0 ? (
        <div className="library-empty">
          {papers.length === 0
            ? '还没有论文 —— 点「打开 PDF」或把文件拖进窗口'
            : `没有匹配「${query}」的论文`}
        </div>
      ) : (
        <ul className="library-list">
          {visible.map((p) => (
            <li
              key={p.id}
              className={`library-item${p.id === currentId ? ' is-current' : ''}`}
              onClick={() => onOpen(p)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onOpen(p);
              }}
              role="button"
              tabIndex={0}
            >
              <span className="library-item-title" title={p.title}>
                {p.title}
              </span>
              <span className="library-item-meta">
                {p.pageCount} 页 · {relativeDay(p.lastOpenedAt)}
                {p.lastPage > 1 ? ` · 读到 ${p.lastPage}` : ''}
              </span>

              {p.tags.length > 0 && (
                <span className="library-tags">
                  {p.tags.map((t) => (
                    <span key={t} className="library-tag">
                      {t}
                    </span>
                  ))}
                </span>
              )}

              {/* 分配菜单触发 */}
              <button
                type="button"
                className="library-item-menu"
                title="归类 / 打标签"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor((v) => (v === p.id ? null : p.id));
                }}
              >
                ⋯
              </button>

              {confirmingId === p.id ? (
                <button
                  type="button"
                  className="library-item-confirm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(p);
                    setConfirmingId(null);
                  }}
                  onBlur={() => setConfirmingId(null)}
                  autoFocus
                >
                  确认删除
                </button>
              ) : (
                <button
                  type="button"
                  className="library-item-delete"
                  title="从论文库删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmingId(p.id);
                    // 3 秒不确认自动还原 —— 误触不应留下悬着的确认态
                    setTimeout(() => setConfirmingId((v) => (v === p.id ? null : v)), 3000);
                  }}
                >
                  ×
                </button>
              )}

              {menuFor === p.id && (
                <div className="library-menu" ref={menuRef} onClick={(e) => e.stopPropagation()}>
                  <div className="library-menu-head">归属集合</div>
                  <div className="library-menu-colls">
                    {collections.length === 0 && (
                      <span className="library-menu-hint">还没有集合，先在下方新建</span>
                    )}
                    {collections.map((c) => (
                      <label key={c.id} className="library-menu-chk">
                        <input
                          type="checkbox"
                          checked={p.collectionIds.includes(c.id)}
                          onChange={() => void libraryStore.togglePaperCollection(p.id, c.id)}
                        />
                        {c.name}
                      </label>
                    ))}
                  </div>

                  <div className="library-menu-head">标签</div>
                  <div className="library-menu-tags">
                    {p.tags.map((t) => (
                      <span key={t} className="library-menu-tag">
                        {t}
                        <button
                          type="button"
                          className="library-menu-tag-x"
                          title="移除标签"
                          onClick={() => void libraryStore.removePaperTag(p.id, t)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  <form
                    className="library-menu-tagrow"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const input = e.currentTarget.elements.namedItem('tag') as HTMLInputElement;
                      const val = input.value.trim();
                      if (!val) return;
                      void libraryStore.addPaperTag(p.id, val);
                      input.value = '';
                    }}
                  >
                    <input name="tag" type="text" placeholder="加标签后回车" className="library-menu-taginput" />
                  </form>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* 新建集合 */}
      <div className="library-newcoll">
        <input
          className="library-newcoll-input"
          type="text"
          placeholder="新建集合…"
          value={newColl}
          onChange={(e) => setNewColl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void createCollection();
          }}
        />
        <button type="button" className="library-newcoll-btn" onClick={() => void createCollection()} disabled={!newColl.trim()}>
          ＋
        </button>
      </div>
    </aside>
  );
}
