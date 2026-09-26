import { useState } from 'react';

import {
  PROVIDER_PRESETS,
  useTranslationSettings,
  updateTranslationSettings,
} from '../state/translationSettings';
import { translationStore, useTranslation } from '../state/translationStore';

/**
 * 一键翻译的工具栏。
 *
 * ── 放在瀑布流外层而不是每一页里 ──
 * 翻译是**整篇文档**的动作（要排队、要限并发、要跨页复用缓存），
 * 不是每页独立的事。放在页里会导致每页各发一批请求，限流与成本都失控。
 */
export function TranslationBar() {
  const snapshot = useTranslation();
  const settings = useTranslationSettings();
  const [showSettings, setShowSettings] = useState(false);

  const { status, progress, byBlockId, message, errors, lastResult, registered } = snapshot;
  const running = status === 'running';

  const translated = byBlockId.size;
  const pct = progress.total > 0 ? Math.round(((progress.done + progress.failed) / progress.total) * 100) : 0;
  const hasKey = settings.apiKey.trim().length > 0;

  return (
    <div className="translate-bar">
      <div className="translate-actions">
        <button
          type="button"
          className="primary"
          data-testid="translate-start"
          disabled={running || registered === 0}
          onClick={() => void translationStore.start()}
          title={hasKey ? '' : '尚未配置 API Key —— 点右侧「翻译设置」填写'}
        >
          {running ? `翻译中 ${pct}%` : '一键翻译'}
        </button>

        {running && (
          <button type="button" data-testid="translate-cancel" onClick={() => translationStore.cancel()}>
            取消
          </button>
        )}

        {!running && translated > 0 && (
          <button type="button" onClick={() => translationStore.clearTranslations()} title="清空译文，不影响缓存">
            清空译文
          </button>
        )}

        <button
          type="button"
          data-testid="translate-settings"
          className={showSettings ? 'active' : ''}
          onClick={() => setShowSettings((v) => !v)}
        >
          翻译设置
          {!hasKey && <span className="dot-warn" title="尚未配置 API Key" />}
        </button>
      </div>

      <div className="translate-status" data-testid="translate-status">
        {progress.total > 0 && (running || lastResult) && (
          <>
            <span>
              进度 {progress.done + progress.failed}/{progress.total}
            </span>
            {progress.cached > 0 && <span className="ok">缓存命中 {progress.cached}</span>}
            {progress.failed > 0 && <span className="bad">失败 {progress.failed}</span>}
          </>
        )}
        {!progress.total && <span>已载入 {registered} 个可译段落</span>}
        {message && <span className="translate-message">{message}</span>}
      </div>

      {running && progress.total > 0 && (
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}

      {errors.length > 0 && (
        <details className="translate-errors">
          <summary>
            {errors.length} 段失败 —— 点开看原因
            {errors.some((e) => /401|403|Key/.test(e.message)) && (
              <span className="bad"> · 看起来是 API Key 的问题</span>
            )}
          </summary>
          <ul>
            {errors.slice(0, 12).map((e, i) => (
              <li key={`${e.id}-${i}`}>
                <span className="bad">{e.message}</span>
                {e.source && <span className="hint"> :: {e.source}…</span>}
              </li>
            ))}
            {errors.length > 12 && <li className="hint">还有 {errors.length - 12} 条…</li>}
          </ul>
        </details>
      )}

      {showSettings && <SettingsPanel />}
    </div>
  );
}

/**
 * 翻译设置。
 *
 * 这一版是**开发期的形态**：Key 存在 localStorage 里。
 * 架构文档定的方案是系统钥匙串，迁到 Tauri 时替换 ——
 * 界面上也把这件事直接写给用户看，而不是藏起来。
 */
function SettingsPanel() {
  const settings = useTranslationSettings();
  const [showKey, setShowKey] = useState(false);

  const preset = PROVIDER_PRESETS.find((p) => p.id === settings.provider);

  return (
    <div className="settings-panel">
      <div className="settings-row">
        <label>服务</label>
        <select
          value={settings.provider}
          onChange={(e) => {
            const next = PROVIDER_PRESETS.find((p) => p.id === e.target.value);
            updateTranslationSettings({
              provider: e.target.value,
              model: next?.model ?? settings.model,
            });
          }}
        >
          {PROVIDER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {preset && <span className="hint">上游 {preset.upstream}</span>}
      </div>

      <div className="settings-row">
        <label>API Key</label>
        <input
          type={showKey ? 'text' : 'password'}
          value={settings.apiKey}
          placeholder="sk-…"
          spellCheck={false}
          onChange={(e) => updateTranslationSettings({ apiKey: e.target.value.trim() })}
        />
        <button type="button" onClick={() => setShowKey((v) => !v)}>
          {showKey ? '隐藏' : '显示'}
        </button>
      </div>

      <div className="settings-row">
        <label>模型</label>
        <input
          type="text"
          value={settings.model}
          spellCheck={false}
          onChange={(e) => updateTranslationSettings({ model: e.target.value.trim() })}
        />
      </div>

      <div className="settings-row">
        <label>接口地址</label>
        <input
          type="text"
          value={settings.baseUrl}
          spellCheck={false}
          onChange={(e) => updateTranslationSettings({ baseUrl: e.target.value.trim() })}
        />
        <span className="hint">
          开发期走 Vite 代理（默认 <code>/api/llm</code>）以绕过 CORS；换服务需同步改
          <code>vite.config.ts</code>
        </span>
      </div>

      <div className="settings-row">
        <label>并发</label>
        <input
          type="number"
          min={1}
          max={16}
          value={settings.concurrency}
          onChange={(e) => updateTranslationSettings({ concurrency: Number(e.target.value) })}
        />
        <label>重试次数</label>
        <input
          type="number"
          min={1}
          max={8}
          value={settings.maxAttempts}
          onChange={(e) => updateTranslationSettings({ maxAttempts: Number(e.target.value) })}
        />
      </div>

      <div className="settings-row">
        <label>
          <input
            type="checkbox"
            checked={settings.previewMode}
            onChange={(e) => updateTranslationSettings({ previewMode: e.target.checked })}
          />
          预览模式（用占位译文填充未翻译的段落，便于评估排版）
        </label>
      </div>

      <p className="settings-note">
        Key 目前存在浏览器 localStorage 里 —— <strong>这不是安全的做法</strong>，任何能在此页面执行脚本的代码都能读到它。
        这只是浏览器原型的临时方案，正式版会改为系统钥匙串。在此之前请使用<strong>额度受限的专用 Key</strong>。
      </p>
    </div>
  );
}
