/**
 * WebKit 兼容补丁（桌面包专用）。
 *
 * ── 为什么要手写这个 ──
 * 打包后的桌面应用跑在**系统 WKWebView** 上，其 JS 引擎能力取决于用户
 * macOS 版本，既不等于 Vite 的构建 target，也不等于开发时用的 Chrome。
 * pdf.js 6.x 内部用了 `Map.prototype.getOrInsertComputed`（较新的 TC39 提案），
 * 在 Safari 18.6（macOS 15.7）上不存在 —— 症状是渲染阶段抛
 * `TypeError: ... is not a function`，界面上只显示「解析失败」，
 * 而开发服务器里一切正常（Chrome 有这个 API）。
 *
 * 这是**运行时 API 缺失**，不是语法问题：改 build.target 或转译都没用，
 * 只能补原型方法。
 *
 * 补丁必须在任何 pdf.js 代码执行之前装好 —— 所以由 main.tsx 第一行引入。
 */

/** 记录补了哪些，便于诊断日志确认（桌面环境落盘，见 desktopLog） */
export const appliedPolyfills: string[] = [];

function patch(
  proto: unknown,
  name: string | symbol,
  value: unknown,
  label: string
): void {
  const target = proto as Record<string | symbol, unknown>;
  const existing = (target as Record<PropertyKey, unknown>)[name];
  if (typeof existing === 'function') return;
  (target as Record<PropertyKey, unknown>)[name] = value;
  appliedPolyfills.push(label);
}

patch(
  Map.prototype,
  'getOrInsertComputed',
  function getOrInsertComputed(this: Map<unknown, unknown>, key: unknown, compute: (k: unknown) => unknown) {
    if (this.has(key)) return this.get(key);
    const value = compute(key);
    this.set(key, value);
    return value;
  },
  'Map.getOrInsertComputed'
);

// 同一个提案里的另一个方法，pdf.js 未来版本可能也会用到，一并补上
patch(
  Map.prototype,
  'getOrInsert',
  function getOrInsert(this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (this.has(key)) return this.get(key);
    this.set(key, value);
    return value;
  },
  'Map.getOrInsert'
);

/**
 * ReadableStream 的 async iterator（`for await (const c of stream)`）。
 *
 * pdf.js 的 getTextContent 正是用它消费文本流 —— 旧 WebKit 上
 * `stream[Symbol.asyncIterator]` 是 undefined，抛「undefined is not a function」。
 * 语义照 Web Streams 规范：逐块 yield；提前退出时取消流，避免泄漏读取者。
 */
patch(
  typeof ReadableStream !== 'undefined' ? ReadableStream.prototype : {},
  Symbol.asyncIterator,
  async function* (this: ReadableStream) {
    const reader = this.getReader();
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          return;
        }
        yield value;
      }
    } finally {
      if (!finished) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  },
  'ReadableStream[Symbol.asyncIterator]'
);
