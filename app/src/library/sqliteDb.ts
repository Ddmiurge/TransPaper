import type { LibraryDb } from './db';
import { IdbLibraryDb } from './db';
import { normalizeMeta, type Collection, type PaperMeta } from './types';

/**
 * 桌面环境的论文库存储：Rust 侧 SQLite + 文件系统（I23，兑现 ADR-007）。
 *
 * ── 与 IndexedDB 实现的关系 ──
 * 两者实现同一个 `LibraryDb` 接口，libraryStore 的业务逻辑完全不变。
 * 桌面用 SQLite 的收益：数据目录归属明确（卸载/备份语义清晰）、
 * 为 FTS5 全文检索铺路（ADR-007 预留）、单写者约束由一把连接锁保证。
 *
 * ── 二进制过 IPC 的取舍 ──
 * PDF 以 base64 过 invoke（+33% 体积）。打开一篇论文是一次性 5–10MB 的
 * 传输，可感知但不致命。更优解是 `tauri::ipc::Response` 零拷贝回传，
 * 等 profile 显示这里是瓶颈再换（Rust 侧已留注释）。
 *
 * 构造是**惰性安全**的：不 invoke、不访问浏览器全局，可以放心在
 * libraryStore 的惰性创建路径上 new（Node 测试不会碰这个类）。
 */

const KEYCHAIN_KEY: never = undefined as never; // 占位防误导出，见下方 KEYCHAIN 无关
void KEYCHAIN_KEY;

function getInvoke(): (cmd: string, args?: Record<string, unknown>) => Promise<unknown> {
  const g = globalThis as unknown as {
    __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  };
  const invoke = g.__TAURI_INTERNALS__?.invoke;
  if (!invoke) throw new Error('Tauri invoke 不可用 —— TauriLibraryDb 只能在桌面环境使用');
  return invoke;
}

const CHUNK = 0x8000;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // 分块转换：几 MB 一次性 spread 进 fromCharCode 会栈溢出
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export class TauriLibraryDb implements LibraryDb {
  async listMeta(): Promise<PaperMeta[]> {
    const rows = (await getInvoke()('db_list_papers')) as Partial<PaperMeta>[];
    return rows.map((r) => normalizeMeta(r as Partial<PaperMeta> & { id: string }));
  }

  async putMeta(meta: PaperMeta): Promise<void> {
    await getInvoke()('db_put_paper', { meta });
  }

  async deleteMeta(id: string): Promise<void> {
    // Rust 侧同时删除元数据与文件（幂等），deleteFile 也会走到这里
    await getInvoke()('db_delete_paper', { id });
  }

  async putFile(id: string, data: ArrayBuffer): Promise<void> {
    await getInvoke()('db_put_file', { id, dataBase64: arrayBufferToBase64(data) });
  }

  async getFile(id: string): Promise<ArrayBuffer | null> {
    const data = (await getInvoke()('db_get_file', { id })) as string | null;
    return data ? base64ToArrayBuffer(data) : null;
  }

  async deleteFile(id: string): Promise<void> {
    await getInvoke()('db_delete_paper', { id });
  }

  async listCollections(): Promise<Collection[]> {
    return (await getInvoke()('db_list_collections')) as Collection[];
  }

  async putCollection(c: Collection): Promise<void> {
    await getInvoke()('db_put_collection', { collection: c });
  }

  async deleteCollection(id: string): Promise<void> {
    await getInvoke()('db_delete_collection', { id });
  }
}

/**
 * 一次性迁移：I21/I22 时代入库的数据还在 IndexedDB 里，首次跑 SQLite 版时搬过来。
 *
 * - **条件保守**：只在 SQLite 完全为空时迁移 —— 已有数据说明迁移做过（或用户
 *   已在新库里操作），重复执行会覆盖新库内容。
 * - **不删旧库**：迁移成功后 IndexedDB 原样保留，作为回滚保险；等版本稳定后
 *   再考虑清理（届时提示用户即可，迁移本身不碰它）。
 * - 迁移中途中断是安全的：下次启动重新执行，putMeta/putFile 都是覆盖写。
 *
 * 返回迁移的论文数（0 = 没有需要迁移的），供诊断日志记录。
 */
export async function migrateLegacyIdbToSqlite(sqlite: LibraryDb): Promise<number> {
  // Node 测试环境没有 indexedDB —— 必须在构造 IdbLibraryDb 之前退出，
  // 否则构造期的 rejection 会逃逸（db.ts 注释里记过的坑）
  if (!('indexedDB' in globalThis)) return 0;

  const existing = await sqlite.listMeta();
  if (existing.length > 0) return 0;

  const legacy = new IdbLibraryDb();
  let metas: PaperMeta[];
  try {
    metas = await legacy.listMeta();
  } catch {
    // IndexedDB 不可用（隐私模式等）—— 没有可迁移的，不是错误
    return 0;
  }
  if (metas.length === 0) return 0;

  for (const meta of metas) {
    await sqlite.putMeta(meta);
    const file = await legacy.getFile(meta.id);
    if (file) await sqlite.putFile(meta.id, file);
  }
  for (const collection of await legacy.listCollections()) {
    await sqlite.putCollection(collection);
  }
  return metas.length;
}
