/**
 * LLM 请求的传输层：同一段领域逻辑（组装请求、分类错误、重试），
 * 在两种环境里用不同的通道发出去。
 *
 * ── 为什么需要两个通道 ──
 * 浏览器里 `fetch` 直连 LLM 服务会被 CORS 拦（服务不发 CORS 头），
 * 开发期靠 Vite 代理；打包后的桌面应用没有 dev server，`/api/llm`
 * 会打到 `tauri://localhost` 直接 404 —— 所以桌面端必须由 Rust 发请求。
 * 选择依据只有一个：是否运行在 Tauri 的 WebView 里（见 isDesktop）。
 */

import { getTauriInvoke, isDesktop } from './desktopLog';
import type { TranslationError } from '../domain/translation';

/** 一次 LLM HTTP 调用的原始结果（领域层据此做错误分类） */
export interface LlmHttpResult {
  status: number;
  body: string;
  /** 服务端 Retry-After 换算成毫秒；没有则 undefined */
  retryAfterMs?: number;
}

export type LlmTransport = (
  url: string,
  apiKey: string,
  bodyJson: string,
  timeoutMs: number,
  signal: AbortSignal
) => Promise<LlmHttpResult>;

/** 解析 Retry-After 头（秒，可能是小数），非法值一律视为没有 */
function parseRetryAfterMs(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** 浏览器通道：经 Vite dev server 的 /api/llm 代理（见 vite.config.ts） */
export const fetchTransport: LlmTransport = async (
  url,
  apiKey,
  bodyJson,
  timeoutMs,
  signal
) => {
  // 超时用「外部 signal + 自己的计时器」组合，而不是 AbortSignal.timeout：
  // 后者无法同时响应用户的取消。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onUserAbort = () => controller.abort(new Error('aborted'));
  signal.addEventListener('abort', onUserAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: bodyJson,
      signal: controller.signal,
    });
    return {
      status: response.status,
      body: await response.text(),
      retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onUserAbort);
  }
};

function getInvoke(): (cmd: string, args?: Record<string, unknown>) => Promise<unknown> {
  const invoke = getTauriInvoke();
  if (!invoke) throw new Error('Tauri invoke 不可用');
  return invoke;
}

/**
 * 桌面通道：请求由 Rust 的 reqwest 发出（command `llm_chat`）。
 *
 * 取消的边界（v1 有意为之）：Tauri command 无法中途掐断 Rust 侧请求，
 * 用户取消时这里只是**放弃等待**——Rust 的请求会跑完然后结果被丢弃，
 * 不会写入缓存，浪费一次调用但不产生错误状态。
 * 若以后要在服务端省这笔钱，再加 CancellationToken 按请求 id 取消。
 */
export const tauriTransport: LlmTransport = async (
  url,
  apiKey,
  bodyJson,
  timeoutMs,
  signal
) => {
  if (url.startsWith('/')) {
    throw new Error(
      '桌面版请求由应用内通道直接发出，接口地址必须是完整的 https:// 地址（如 https://api.deepseek.com）'
    );
  }

  const invoke = getInvoke();
  // 已取消的请求不能再发出去 —— invoke 必须在 abort 检查之后
  if (signal.aborted) {
    throw new DOMException('aborted', 'AbortError');
  }
  const request = invoke('llm_chat', { url, apiKey, body: bodyJson, timeoutMs }) as Promise<LlmHttpResult>;

  // Rust 的超时由 reqwest 负责；这里只响应用户的取消
  return new Promise<LlmHttpResult>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    request.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
};

/** 按运行环境选择通道。测试可以注入覆盖 */
export function defaultTransport(): LlmTransport {
  return isDesktop() ? tauriTransport : fetchTransport;
}

/** 把 Rust 侧的错误串归一为领域错误（超时要能跟「网络不通」区分开） */
export function isTimeoutError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /timed?\s?out|超时/i.test(text);
}

export type { TranslationError };
