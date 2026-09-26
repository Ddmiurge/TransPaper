import { useSyncExternalStore } from 'react';

/**
 * 翻译设置。
 *
 * ── 关于 API Key 的存放，必须说清楚 ──
 * 当前原型把 Key 放在 localStorage 里，**这不是安全的做法**：
 * 任何能在这个 origin 上执行脚本的东西都能读到它。
 * 之所以还这么做，是因为浏览器原型没有更好的选择（没有系统钥匙串可用）。
 *
 * 架构文档 `docs/05-tech-stack.md` 里定的方案是**系统钥匙串**（macOS Keychain /
 * Windows Credential Manager / libsecret），迁到 Tauri 时必须换成那个。
 * 在那之前，建议用**额度受限的专用 Key**，不要用主账号的。
 *
 * 同时支持从 Vite 环境变量读默认值（`VITE_DEEPSEEK_API_KEY`），
 * 方便本地开发时不必每次粘贴 —— 但那要求把 Key 写进 `.env.local`，
 * 同样要自己确保它不进版本库。
 */

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
  // 走 Vite 的 /api/llm 代理。直连地址是 https://api.deepseek.com
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

/** 预设服务。baseUrl 都指向代理，只换 target 需改 vite.config.ts */
export const PROVIDER_PRESETS: Array<{
  id: string;
  label: string;
  model: string;
  /** 真实域名，展示给用户看，便于他们自己去改 vite.config.ts */
  upstream: string;
}> = [
  { id: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat', upstream: 'api.deepseek.com' },
  { id: 'moonshot', label: 'Kimi（月之暗面）', model: 'moonshot-v1-8k', upstream: 'api.moonshot.cn' },
  {
    id: 'dashscope',
    label: '通义千问',
    model: 'qwen-plus',
    upstream: 'dashscope.aliyuncs.com/compatible-mode/v1',
  },
  {
    id: 'local',
    label: '本地 / 自建（Ollama 等）',
    model: 'qwen2.5:7b',
    upstream: '127.0.0.1:11434/v1',
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

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getSnapshot = (): TranslationSettings => this.snapshot;

  update(patch: Partial<TranslationSettings>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    persist(this.snapshot);
    for (const listener of this.listeners) listener();
  }

  private load(): TranslationSettings {
    const envKey = readEnvDefault();
    const base: TranslationSettings = { ...DEFAULT_SETTINGS, apiKey: envKey };
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return base;
      const parsed = JSON.parse(raw) as Partial<TranslationSettings>;
      // 逐字段校验类型：localStorage 的内容可能被手改或被旧版本写入，
      // 直接展开会让非法值（如 concurrency 是字符串）流进调度器
      return {
        provider: str(parsed.provider, base.provider),
        baseUrl: str(parsed.baseUrl, base.baseUrl),
        apiKey: str(parsed.apiKey, base.apiKey),
        model: str(parsed.model, base.model),
        concurrency: clampInt(parsed.concurrency, 1, 16, base.concurrency),
        maxAttempts: clampInt(parsed.maxAttempts, 1, 8, base.maxAttempts),
        baseDelayMs: clampInt(parsed.baseDelayMs, 100, 30_000, base.baseDelayMs),
        previewMode: typeof parsed.previewMode === 'boolean' ? parsed.previewMode : base.previewMode,
      };
    } catch {
      return base;
    }
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
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
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
