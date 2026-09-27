import { describe, it, expect, vi, afterEach } from 'vitest';

import type { LlmHttpResult } from '../llmTransport';

/**
 * 桌面通道的参数组装与结果透传。
 *
 * mock 的就是 `__TAURI_INTERNALS__.invoke` 这一层 —— 它是前端与 Rust
 * 的全部边界。Rust 侧的 HTTP 行为（状态码透传 / Retry-After / 超时）
 * 在 src-tauri/src/llm.rs 的单元测试里验证，两边合起来才是完整链路。
 */

function stubTauri(invokeImpl: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
  const invoke = vi.fn(invokeImpl);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  return invoke;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tauriTransport（桌面通道）', () => {
  it('把 URL / Key / 请求体 / 超时原样交给 Rust command，结果透传', async () => {
    const result: LlmHttpResult = { status: 429, body: '{"error":{}}', retryAfterMs: 2000 };
    const invoke = stubTauri(async () => result);

    const { tauriTransport } = await import('../llmTransport');
    const out = await tauriTransport(
      'https://api.deepseek.com/chat/completions',
      'sk-abc',
      '{"model":"m"}',
      60000,
      new AbortController().signal
    );

    expect(out).toEqual(result);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('llm_chat');
    expect(invoke.mock.calls[0][1]).toEqual({
      url: 'https://api.deepseek.com/chat/completions',
      apiKey: 'sk-abc',
      body: '{"model":"m"}',
      timeoutMs: 60000,
    });
  });

  it('相对路径的 baseUrl（Vite 代理写法）在桌面必然 404，直接报可理解的错', async () => {
    const invoke = stubTauri(async () => ({ status: 200, body: '' }));
    const { tauriTransport } = await import('../llmTransport');

    await expect(
      tauriTransport('/api/llm/chat/completions', 'k', '{}', 1000, new AbortController().signal)
    ).rejects.toThrow(/完整/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('signal 已取消时立即 reject，不发起 Rust 调用', async () => {
    const invoke = stubTauri(async () => ({ status: 200, body: '' }));
    const { tauriTransport } = await import('../llmTransport');

    const controller = new AbortController();
    controller.abort();
    await expect(
      tauriTransport('https://x.dev', 'k', '{}', 1000, controller.signal)
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('defaultTransport（按环境分流）', () => {
  it('桌面环境选 Rust 通道，浏览器环境选 fetch 通道', async () => {
    const { defaultTransport } = await import('../llmTransport');

    stubTauri(async () => ({ status: 200, body: '' }));
    const desktopTransport = defaultTransport();
    vi.unstubAllGlobals();

    const fetchSpy = vi.fn(async () => ({
      status: 200,
      text: async () => '',
      headers: { get: () => null },
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const browserTransport = defaultTransport();

    // 用行为区分：桌面通道调用会命中 invoke stub，浏览器通道命中 fetch stub
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn(async () => ({ status: 200, body: '' })) });
    await desktopTransport('https://x.dev', 'k', '{}', 1000, new AbortController().signal);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', fetchSpy);
    await browserTransport('/api/llm/chat/completions', 'k', '{}', 1000, new AbortController().signal);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/llm/chat/completions',
      expect.objectContaining({ method: 'POST' })
    );
  });
});

describe('fetchTransport（浏览器通道）', () => {
  it('透传状态与 body，解析 Retry-After', async () => {
    const fetchSpy = vi.fn(async () => ({
      status: 429,
      text: async () => 'rate limited',
      headers: { get: (name: string) => (name === 'retry-after' ? '2' : null) },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const { fetchTransport } = await import('../llmTransport');
    const out = await fetchTransport('/api/llm', 'k', '{}', 1000, new AbortController().signal);

    expect(out.status).toBe(429);
    expect(out.body).toBe('rate limited');
    expect(out.retryAfterMs).toBe(2000);
  });
});
