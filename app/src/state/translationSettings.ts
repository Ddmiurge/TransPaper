import { useSyncExternalStore } from 'react';

import { isDesktop, logLine, describeError } from '../infra/desktopLog';

/**
 * 翻译设置。
 *
 * ── API Key 存哪 ──
 * - **浏览器环境**：localStorage（没有更好的选择）。**这不是安全的做法**，
 *   任何能在这个 origin 上执行脚本的东西都能读到它 —— 建议用额度受限的专用 Key。
 * - **桌面环境**：系统钥匙串（macOS Keychain，经 Rust 的 `secret_set/get`），
 *   兑现 ADR-011 §5 的承诺。localStorage 里的这份设置**不再保存 Key**，
 *   启动时由 `hydrateApiKey()` 异步取回。
 *
 * 同时支持从 Vite 环境变量读默认值（`VITE_DEEPSEEK_API_KEY`），
 * 只对浏览器开发有用 —— 方便本地开发时不必每次粘贴。
 */

/** 钥匙串里 Key 的条目名（对应 Rust 侧 `secret_get/set` 的 key 参数） */
const KEYCHAIN_KEY = 'llm-api-key';

export interface TranslationSettings {
  provider: string;
  /** 模型服务地址。开发期默认走 Vite 代理以绕过 CORS */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 并发请求数 */
  concurrency: number;
  maxAttempts: number;
  baseDelayMs: number;
  /**
   * 预览模式：用本地占位译文填充缺失的段落。
   *
   * 存在的意义是在**没有 API Key 时仍能评估排版**（行宽、缩进、回行、撑开倍数）。
   * 真实译文一旦到达会自动覆盖占位内容，所以开着它不影响真实翻译，
   * 只是让没配 Key 时的页面不至于空空如也。
   */
  previewMode: boolean;
}

const STORAGE_KEY = 'paper-reader:translation-settings';

export const DEFAULT_SETTINGS: TranslationSettings = {
  provider: 'deepseek',
  // 浏览器开发走 Vite 的 /api/llm 代理；桌面由 Rust 直发，必须是完整地址。
  // 两边都要能用 —— 所以按环境取默认值（见下方 desktopDefaults）
  baseUrl: '/api/llm',
  apiKey: '',
  model: 'deepseek-chat',
  /**
   * 并发 4。
   *
   * 取这个值的理由：DeepSeek 对并发不算敏感，但设太高会在长文档上触发 429，
   * 而 429 重试带来的退避等待反而更慢。4 段并发已经能让 100 段在一两分钟内完成。
   */
  concurrency: 4,
  maxAttempts: 3,
  /** 退避基数 800ms：429 通常几百毫秒就恢复，不必等太久 */
  baseDelayMs: 800,
  previewMode: true,
};

/** 桌面环境的差异项。localStorage 里存的旧 `/api/llm` 值也会被它纠正 */
const DESKTOP_OVERRIDES: Partial<TranslationSettings> = {
  baseUrl: 'https://api.deepseek.com',
};

/** 预设服务。浏览器走代理只换 target；桌面直接用 origin 作 baseUrl */
export const PROVIDER_PRESETS: Array<{
  id: string;
  label: string;
  model: string;
  /** 真实域名，展示给用户看，便于他们自己去改 vite.config.ts */
  upstream: string;
  /** 完整接口地址 —— 桌面环境切换预设时自动填入 baseUrl */
  origin: string;
}> = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    model: 'deepseek-chat',
    upstream: 'api.deepseek.com',
    origin: 'https://api.deepseek.com',
  },
  {
    id: 'moonshot',
    label: 'Kimi（月之暗面）',
    model: 'moonshot-v1-8k',
    upstream: 'api.moonshot.cn',
    origin: 'https://api.moonshot.cn',
  },
  {
    id: 'dashscope',
    label: '通义千问',
    model: 'qwen-plus',
    upstream: 'dashscope.aliyuncs.com/compatible-mode/v1',
    origin: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  {
    id: 'mimo',
    label: 'MiMo（小米）',
    model: 'mimo-v2.6-pro',
    upstream: 'api.xiaomimimo.com/v1',
    origin: 'https://api.xiaomimimo.com/v1',
  },
  {
    id: 'local',
    label: '本地 / 自建（Ollama 等）',
    model: 'qwen2.5:7b',
    upstream: '127.0.0.1:11434/v1',
    origin: 'http://127.0.0.1:11434/v1',
  },
];

type Listener = () => void;

function readEnvDefault(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
    return env.VITE_DEEPSEEK_API_KEY ?? '';
  } catch {
    return '';
  }
}

class SettingsStore {
  private snapshot: TranslationSettings = this.load();
  private readonly listeners = new Set<Listener>();
  /** 桌面环境钥匙串写入的防抖计时器 —— 输入框每敲一个字都会触发 update */
  private keychainTimer: number | null = null;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getSnapshot = (): TranslationSettings => this.snapshot;

  update(patch: Partial<TranslationSettings>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    persist(this.snapshot);
    this.persistApiKey(this.snapshot.apiKey);
    for (const listener of this.listeners) listener();
  }

  private load(): TranslationSettings {
    const envKey = readEnvDefault();
    const base: TranslationSettings = {
      ...(isDesktop() ? { ...DEFAULT_SETTINGS, ...DESKTOP_OVERRIDES } : DEFAULT_SETTINGS),
      apiKey: envKey,
    };
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return base;
      const parsed = JSON.parse(raw) as Partial<TranslationSettings>;
      // 逐字段校验类型：localStorage 的内容可能被手改或被旧版本写入，
      // 直接展开会让非法值（如 concurrency 是字符串）流进调度器
      const loaded: TranslationSettings = {
        provider: str(parsed.provider, base.provider),
        baseUrl: str(parsed.baseUrl, base.baseUrl),
        // Key 的恢复路径按环境分流：浏览器仍是 localStorage（原有行为），
        // 桌面永远为空 —— 等 hydrateApiKey() 从钥匙串取回
        apiKey: isDesktop() ? '' : str(parsed.apiKey, base.apiKey),
        model: str(parsed.model, base.model),
        concurrency: clampInt(parsed.concurrency, 1, 16, base.concurrency),
        maxAttempts: clampInt(parsed.maxAttempts, 1, 8, base.maxAttempts),
        baseDelayMs: clampInt(parsed.baseDelayMs, 100, 30_000, base.baseDelayMs),
        previewMode: typeof parsed.previewMode === 'boolean' ? parsed.previewMode : base.previewMode,
      };
      if (isDesktop()) {
        // localStorage 里旧版存过 /api/llm —— 桌面上这个地址必然 404，强制纠正
        loaded.baseUrl = DESKTOP_OVERRIDES.baseUrl ?? loaded.baseUrl;
      }
      return loaded;
    } catch {
      return base;
    }
  }

  /**
   * Key 的持久化分流：桌面写钥匙串（防抖），浏览器不持久化 Key。
   *
   * 防抖的理由：输入框 onChange 逐字符触发 update，而钥匙串每次写入
   * 都要走一次系统调用（macOS 上还可能弹授权）；800ms 内连续输入只写最后值。
   */
  private persistApiKey(apiKey: string): void {
    if (!isDesktop()) return;
    if (this.keychainTimer !== null) window.clearTimeout(this.keychainTimer);
    this.keychainTimer = window.setTimeout(() => {
      this.keychainTimer = null;
      void writeKeychainKey(apiKey);
    }, 800);
  }
}

function getInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const g = globalThis as unknown as {
    __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  };
  return g.__TAURI_INTERNALS__?.invoke ?? null;
}

async function writeKeychainKey(apiKey: string): Promise<void> {
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    if (apiKey) {
      await invoke('secret_set', { key: KEYCHAIN_KEY, value: apiKey });
    } else {
      // 清空输入 = 删除条目，而不是存一个空串
      await invoke('secret_delete', { key: KEYCHAIN_KEY });
    }
  } catch (err) {
    logLine(`keychain set FAIL: ${describeError(err)}`);
  }
}

/**
 * 启动时从钥匙串取回 Key（仅桌面）。
 *
 * 必须在 UI 挂载后调用 —— 结果通过 update 广播，输入框自动填上。
 * 只在当前没有 Key 时写入：避免和用户正在输入的内容互相覆盖。
 */
export async function hydrateApiKey(): Promise<void> {
  if (!isDesktop()) return;
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    const value = await invoke('secret_get', { key: KEYCHAIN_KEY });
    if (typeof value === 'string' && value && !settingsStore.getSnapshot().apiKey) {
      settingsStore.update({ apiKey: value });
    }
  } catch (err) {
    logLine(`keychain get FAIL: ${describeError(err)}`);
  }
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function persist(settings: TranslationSettings): void {
  try {
    // 桌面环境的 Key 存钥匙串，localStorage 里只留无敏感性的其余设置
    const payload = isDesktop() ? { ...settings, apiKey: '' } : settings;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* 隐私模式下写不进去，只是设置不持久，不影响本次会话 */
  }
}

const settingsStore = new SettingsStore();

export function useTranslationSettings(): TranslationSettings {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot);
}

export function updateTranslationSettings(patch: Partial<TranslationSettings>): void {
  settingsStore.update(patch);
}

/** 供翻译流程（非 React 环境）同步读取 */
export function loadSettings(): TranslationSettings {
  return settingsStore.getSnapshot();
}
