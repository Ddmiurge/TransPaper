import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    /**
     * LLM API 的 CORS 代理。
     *
     * ── 为什么必须转发 ──
     * OpenAI 兼容的模型服务都不给浏览器发 `Access-Control-Allow-Origin`，
     * 浏览器直连会被 CORS 拦下，而且**报错信息是"Failed to fetch"** ——
     * 完全看不出是 CORS 问题，很容易误判成网络不通或 Key 错误。
     *
     * 转发给 dev server 之后，请求变成同源，浏览器不再介入。
     * 迁到 Tauri 后由 Rust 侧发起请求，这段代理就不需要了 ——
     * 这也是适配器把 baseUrl 做成参数的原因（见 infra/openaiCompatible.ts）。
     *
     * 默认指向 DeepSeek；换服务改这一处即可。
     */
    proxy: {
      '/api/llm': {
        // 可用环境变量临时指向本地假模型服务，便于在没有 Key 时验证全链路：
        //   LLM_PROXY_TARGET=http://127.0.0.1:8787 npx vite
        target: process.env.LLM_PROXY_TARGET ?? 'https://api.deepseek.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/llm/, ''),
        // 翻译请求可能要跑几十秒（长段落 + 排队），默认超时太短会被 dev server 掐断
        timeout: 120_000,
        proxyTimeout: 120_000,
      },
    },
  },
  // 注意：不要加 assetsInclude: ['**/*.mjs']。
  // 那会把 pdfjs-dist/build/pdf.mjs 也当成静态资源处理，导致 getDocument / GlobalWorkerOptions
  // 全部变成 undefined（构建期会给出 IMPORT_IS_UNDEFINED 警告，但只有真的跑起来才暴露）。
  // worker 文件用显式的 ?url 后缀导入即可，不需要改全局规则。
});
