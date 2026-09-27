# I20 小结 · 集合改名 UI

> 迭代日期：2026-09-27 · 触发：路线图遗留小项（`renameCollection` 已在 I14 就绪，只差入口）

## 做了什么

- 侧边栏集合项增加 **✎ 内联改名**：点击后标签变输入框，回车提交 / Esc 取消 /
  失焦提交；不弹窗、不改导航结构。
- 复用已就绪的 `libraryStore.renameCollection`，持久化随 `putMeta` 走 IndexedDB。
- e2e（`verify-library.mjs`）追加：✎ → 输入「视觉模型」→ 回车 → 刷新后仍生效。

## 顺带修掉的一个真问题

e2e 第一次跑失败：导航里凭空多出一个集合。根因是**浏览器 profile 复用**——
IndexedDB 存在 `/tmp/edge-lib-profile` 里，上一轮的「深度学习」残留到本轮，
让断言不可重复。已在脚本开头清空 profile 目录。

这类污染很隐蔽：症状是「断言偶发失败」，真因却是测试基础设施，不是产品代码。

## 验证

- 端到端全过：入库 → 建集合 → 归属 → 打标签 → 过滤 → 刷新持久化 → **改名 → 刷新持久化**；
- 全量 21 文件 / 205 用例 · tsc 0 错误 · build OK。

## 备注

真实浏览器里顺带确认了 I15 的标题提取生效：入库条目标题显示为论文真标题
「Deep Residual Learning for Image Recognition」而非文件名。
