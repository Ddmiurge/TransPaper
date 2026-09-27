// 必须是第一行：pdf.js 依赖的较新 Map 方法要在它加载前补好
import { appliedPolyfills } from './infra/webkitPolyfills';

import { createRoot } from 'react-dom/client';

import App from './App';
import { installGlobalErrorLog, logLine } from './infra/desktopLog';
import './styles.css';

// 桌面环境没有 DevTools，先装好日志兜底，再渲染任何东西
installGlobalErrorLog();
logLine(`boot: polyfills=[${appliedPolyfills.join(',')}] ua=${navigator.userAgent}`);

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点');

createRoot(container).render(<App />);
