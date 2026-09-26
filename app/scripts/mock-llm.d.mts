/**
 * `scripts/mock-llm.mjs` 的类型声明。
 *
 * 那个文件是 .mjs（要被 `node scripts/mock-llm.mjs` 直接跑），
 * 而集成测试用 ESM import 引入它。TS 对 .mjs 不做隐式 any，
 * 所以在这里声明一次，让测试拿到类型而不是 `any`。
 */
import type { Server } from 'node:http';

export interface MockLlmOptions {
  /** 请求日志。测试里传空函数可以保持输出干净 */
  logger?: (msg: string) => void;
  /** 正常响应的随机延迟区间（毫秒）。测试里压小以加快速度 */
  delayRange?: [number, number];
}

export interface MockLlmApp {
  server: Server;
  /** 服务端观测到的在途请求峰值，用于断言「客户端并发上限是否被遵守」 */
  readonly maxInFlight: number;
  /** 收到的请求总数 */
  readonly requestCount: number;
  /** 开始监听。传 0 由系统分配空闲端口，返回形如 http://127.0.0.1:54321 */
  listen(port?: number): Promise<string>;
  close(): Promise<void>;
}

export function createMockLlm(options?: MockLlmOptions): MockLlmApp;
