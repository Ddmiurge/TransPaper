#!/usr/bin/env bash
# 一键安装桌面应用到 /Applications（I24）。
#
# 做两件事：
# 1. ad-hoc 签名（codesign -s -）：没有 Apple 开发者账号时的临时方案，
#    让 Gatekeeper 对「本地构建」的来源检查可过；正式分发才需要公证。
# 2. 拷贝到 /Applications（覆盖旧版），Dock/Finder 里的 TransPaper 就是它。
#
# 用法：bash app/scripts/install-app.sh
# 前提：先跑过 npx tauri build（产物在 app/src-tauri/target/release/bundle/macos/）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/app/src-tauri/target/release/bundle/macos/TransPaper.app"

if [ ! -d "$APP" ]; then
  echo "找不到构建产物：$APP" >&2
  echo "请先执行: cd app && npx tauri build" >&2
  exit 1
fi

echo "→ ad-hoc 签名"
codesign --force --deep -s - "$APP"

echo "→ 拷贝到 /Applications（覆盖旧版）"
rm -rf /Applications/TransPaper.app
cp -R "$APP" /Applications/

echo "✔ 已安装：/Applications/TransPaper.app"
