import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 设置存储的环境分流（I22）：
 * - 桌面：Key 只进钥匙串（防抖写入），localStorage 里不带 Key；
 *   baseUrl 里的代理写法被纠正成完整地址
 * - 浏览器：Key 仍存 localStorage（原有行为），baseUrl 默认走代理
 *
 * translationSettings 是模块级单例，且 import 时就读 window ——
 * 所以每个用例都先装好 stub 再动态 import（vi.resetModules 清缓存）。
 * 防抖是 800ms 真实计时器，用例里直接等待（简单可靠，不与 fake timers 纠缠）。
 */

const STORAGE_KEY = 'paper-reader:translation-settings';
const DEBOUNCE_MS = 950;

function installStubs(options: { tauri: boolean }) {
  const store = new Map<string, string>();
  const windowStub = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => void store.clear(),
    },
    // 转发到 global：模块内通过 window.setTimeout 调防抖
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  };
  vi.stubGlobal('window', windowStub);

  let keychain: string | null = null;
  const invokeCalls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  if (options.tauri) {
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      invokeCalls.push({ cmd, args });
      if (cmd === 'secret_get') return keychain;
      if (cmd === 'secret_set') {
        keychain = String(args?.value);
        return null;
      }
      if (cmd === 'secret_delete') {
        keychain = null;
        return null;
      }
      return null;
    });
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  }
  return { store, invokeCalls, getKeychain: () => keychain };
}

async function importModule() {
  vi.resetModules();
  return await import('../translationSettings');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('桌面环境（Tauri WebView）', () => {
  it('默认 baseUrl 是完整地址，localStorage 里的旧代理写法被强制纠正', async () => {
    installStubs({ tauri: true });
    // 模拟旧版本写入的设置（带代理地址）
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl: '/api/llm' }));

    const { loadSettings } = await importModule();
    expect(loadSettings().baseUrl).toBe('https://api.deepseek.com');
  });

  it('Key 走钥匙串（防抖取最后一次），localStorage 里不含 Key', async () => {
    const h = installStubs({ tauri: true });
    const { updateTranslationSettings, loadSettings } = await importModule();

    updateTranslationSettings({ apiKey: 'sk-first' });
    // 防抖窗口内不落钥匙串；连续输入只保留最后一次
    updateTranslationSettings({ apiKey: 'sk-final' });
    expect(h.getKeychain()).toBeNull();

    // localStorage 不落 Key
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      apiKey?: string;
    };
    expect(persisted.apiKey).toBe('');

    await sleep(DEBOUNCE_MS);
    expect(h.getKeychain()).toBe('sk-final');
    expect(loadSettings().apiKey).toBe('sk-final');
  });

  it('清空 Key = 删除钥匙串条目（而不是存空串）', async () => {
    const h = installStubs({ tauri: true });
    const { updateTranslationSettings } = await importModule();

    updateTranslationSettings({ apiKey: 'sk-temp' });
    await sleep(DEBOUNCE_MS);
    expect(h.getKeychain()).toBe('sk-temp');

    updateTranslationSettings({ apiKey: '' });
    await sleep(DEBOUNCE_MS);
    expect(h.getKeychain()).toBeNull();
  });

  it('hydrateApiKey 从钥匙串取回 Key 并进入快照（模拟重启）', async () => {
    const h = installStubs({ tauri: true });
    const first = await importModule();
    first.updateTranslationSettings({ apiKey: 'sk-hydrated' });
    await sleep(DEBOUNCE_MS);
    expect(h.getKeychain()).toBe('sk-hydrated');

    // 重新加载模块 = 重启应用（快照为空），hydrate 后恢复
    const reloaded = await importModule();
    expect(reloaded.loadSettings().apiKey).toBe('');
    await reloaded.hydrateApiKey();
    expect(reloaded.loadSettings().apiKey).toBe('sk-hydrated');
  });
});

describe('浏览器环境', () => {
  it('Key 仍存 localStorage（原有行为），baseUrl 默认走代理', async () => {
    installStubs({ tauri: false });
    const { updateTranslationSettings } = await importModule();

    updateTranslationSettings({ apiKey: 'sk-browser' });
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      apiKey?: string;
      baseUrl?: string;
    };
    expect(persisted.apiKey).toBe('sk-browser');
    expect(persisted.baseUrl).toBe('/api/llm');

    // 重新加载（模拟刷新）后 Key 仍从 localStorage 恢复
    const reloaded = await importModule();
    expect(reloaded.loadSettings().apiKey).toBe('sk-browser');
  });
});
