import {
  TranslationError,
  buildTranslationPrompt,
  TRANSLATION_SYSTEM_PROMPT,
  type TranslatorPort,
} from '../domain/translation';
import { defaultTransport, isTimeoutError, type LlmHttpResult, type LlmTransport } from './llmTransport';

/**
 * OpenAI 兼容的翻译适配器。
 *
 * 覆盖 DeepSeek / Kimi / 通义 / Ollama / 任意自建网关 —— 它们都是
 * `/chat/completions` 那一套。换服务只改 baseUrl 与 model。
 *
 * ── 关于 baseUrl 与 CORS ──
 * 浏览器直连 LLM API 会被 CORS 拦住（这些服务不给浏览器发 CORS 头）。
 * 所以浏览器环境的 `baseUrl` 走 Vite 的代理（`/api/llm` → 真实域名），
 * 由 dev server 转发；桌面环境则由 Rust 直接发请求（tauriTransport），
 * 没有代理概念，baseUrl 必须是完整的 https:// 地址 —— 通道选择见 llmTransport。
 */

export interface OpenAICompatibleOptions {
  /** 例如 `/api/llm`（浏览器经 Vite 代理）或 `https://api.deepseek.com` */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单次请求超时（毫秒）。论文段落不会太长，60s 足够 */
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  /** 发送通道。缺省按运行环境自动选择（桌面 → Rust，浏览器 → Vite 代理） */
  transport?: LlmTransport;
}

const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * 输出上限。
 *
 * 不设的话，偶发的模型跑飞会一直吐到用完上下文，既慢又贵。
 * 中文译文约为原文字符数的 0.6 倍，而 max_tokens 计的是 token：
 * 一段 2000 字符的正文约需 1400 token 左右，4096 有充裕余量。
 */
const DEFAULT_MAX_TOKENS = 4096;
/**
 * 温度取 0.2 而不是 0。
 *
 * 翻译要的是稳定而非创造，所以接近 0；但完全取 0 时部分服务端实现
 * 会退化成贪心解码，短句容易陷入重复循环。
 */
const DEFAULT_TEMPERATURE = 0.2;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  error?: { message?: string; type?: string; code?: string };
}

export class OpenAICompatibleTranslator implements TranslatorPort {
  private readonly opts: Required<OpenAICompatibleOptions>;

  constructor(options: OpenAICompatibleOptions) {
    this.opts = {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxTokens: DEFAULT_MAX_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      transport: defaultTransport(),
      ...options,
    };
  }

  async translate(source: string, signal: AbortSignal): Promise<string> {
    if (!this.opts.apiKey) {
      throw new TranslationError('auth', '未配置 API Key');
    }

    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const bodyJson = JSON.stringify({
      model: this.opts.model,
      messages: [
        { role: 'system', content: TRANSLATION_SYSTEM_PROMPT },
        { role: 'user', content: buildTranslationPrompt(source) },
      ],
      temperature: this.opts.temperature,
      max_tokens: this.opts.maxTokens,
      stream: false,
    });

    let result: LlmHttpResult;
    try {
      // 超时与取消的职责在通道内（fetch 用计时器，桌面由 Rust 的 reqwest 超时）
      result = await this.opts.transport(url, this.opts.apiKey, bodyJson, this.opts.timeoutMs, signal);
    } catch (err) {
      // AbortError 有两种来源，必须区分：用户取消 vs 超时。
      // 混为一谈的话，超时会被当成「用户取消」而静默丢弃。
      if (signal.aborted) throw new TranslationError('aborted', '已取消');
      if (isTimeoutError(err)) {
        throw new TranslationError('network', `请求超时（${this.opts.timeoutMs / 1000}s）`);
      }
      throw new TranslationError(
        'network',
        `网络请求失败：${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }

    if (result.status < 200 || result.status >= 300) {
      throw classifyHttpError(result);
    }

    let payload: ChatCompletionResponse;
    try {
      payload = JSON.parse(result.body) as ChatCompletionResponse;
    } catch (err) {
      throw new TranslationError('server', '响应不是合法 JSON', { cause: err });
    }

    if (payload.error?.message) {
      throw new TranslationError('bad-request', `服务返回错误：${payload.error.message}`);
    }

    const choice = payload.choices?.[0];
    const text = choice?.message?.content?.trim() ?? '';

    if (!text) {
      // 空返回通常是两种原因：命中内容过滤，或被 max_tokens 截断在开头。
      // finish_reason 能区分它们，报文里带上便于排查。
      const reason = choice?.finish_reason ?? 'no-choice';
      throw new TranslationError('empty', `模型返回空内容（finish_reason=${reason}）`);
    }

    return text;
  }
}

/**
 * 把 HTTP 状态码翻译成本领域的错误分类。
 *
 * **这个分类直接决定重试行为**：401 重试一百次也不会成功，
 * 只会让用户以为「在跑」而实际上一直在失败。
 */
function classifyHttpError(result: LlmHttpResult): TranslationError {
  const status = result.status;
  let detail = '';
  try {
    const body = JSON.parse(result.body) as ChatCompletionResponse;
    detail = body.error?.message ?? '';
  } catch {
    detail = result.body.slice(0, 200);
  }
  const suffix = detail ? `：${detail.slice(0, 200)}` : '';

  if (status === 401 || status === 403) {
    return new TranslationError('auth', `API Key 无效或无权限（HTTP ${status}）${suffix}`);
  }
  if (status === 429) {
    return new TranslationError('rate-limit', `触发限流（HTTP 429）${suffix}`, {
      retryAfterMs: result.retryAfterMs,
    });
  }
  if (status >= 500) {
    return new TranslationError('server', `服务端错误（HTTP ${status}）${suffix}`);
  }
  return new TranslationError('bad-request', `请求被拒绝（HTTP ${status}）${suffix}`);
}
