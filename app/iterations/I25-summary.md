# I25 迭代小结 · 跨页段落接续

> I25 · 状态：**已完成** · 决策记录见 [ADR-017](../../docs/adr/ADR-017-cross-page-paragraph-continuation.md)
> 样本：三基线（ResNet / 单栏 42 页 / ACL 17 页）

## 问题

段落重建逐页进行，跨过页边界的段落被腰斩成两个块：前半段缺下文、后半段缺上文，
各自送译导致跨界处指代与句法断裂；且后半段被当成新段落误加首行缩进。
从 I6 起一直挂在候选清单上，是 R3 阅读质量的最后一块已知欠账。

## 方案（ADR-017）

- 逐页串联（沿用 `referencesActive` 模式）：页 N 上报「段落尾部」，
  页 N+1 与本页首块做接续判定；
- 判定成立 → **两半合并为一个翻译单元**（登记在宿主块 id 下），
  尾块注销、宿主去首行缩进，合并译文整体显示在宿主块下；
- **刻意不切分回两半**（ADR-011 的教训：依赖模型输出分隔格式必然赌运气）；
- 判据保守：尾部以未完字符收尾（字母/数字/逗号/分号/连接符），
  头部以小写/逗号/分号开头；冒号、括号、数字编号一律不并；
- 行内公式占位符跨块重编号（`mergeMasked`），回填用合并片段。

## 改动

| 文件 | 内容 |
|---|---|
| `domain/crossPage.ts`（新） | `endsOpen` / `startsContinuation` / `paragraphTailInfoOf` / `isContinuation` / `mergeMasked` |
| `domain/pageFlow.ts` | `FlowText.continuesFrom` / `mathPieces`；options 增 `continuationHeadIds` / `mergedMathPieces` |
| `state/translationStore.ts` | `unregister`（连译文/告警/失败明细一起清）、`isRegisteredWith`（幂等守卫） |
| `components/PageFlowBlock.tsx` | `prevTail` prop、continuation memo、合并登记、预览模式按合并整段给占位译文 |
| `components/PageFlowView.tsx` | 译文回填优先用合并片段；宿主块加 `flow-block--continued` |
| `App.tsx` | `tailStates` 逐页串联（与 referenceStates 同款） |
| `styles.css` | `.flow-block--continued .flow-source { text-indent: 0 }` |
| `scripts/verify-continuation.mjs`（新） | e2e：接续宿主存在、缩进为 0、合并单元渲染 |

## 验证

- 单测 +18（`crossPage.test.ts`：判定/尾部候选/合并重编号/回填往返/多位编号不误伤）
- 真实 PDF +4（`crossPage.real.test.ts`：三基线 12 页内各 ≥1 个接续对；
  被合并对的尾部确实以未完字符收尾）
- store +2（注销幂等、已产生的译文一并清除、isRegisteredWith 守卫）
- **239 用例全绿**（215 → 239），tsc 0，build OK
- e2e（verify-continuation.mjs）：ResNet 第 2→3、4→5 页边界各检出 1 个接续宿主，
  文本以延续特征开头、缩进 0px（对照：普通段缩进非 0）、合并译文挂在宿主下

## 踩坑

- **e2e 的预览模式 checkbox 默认就是勾选的** —— 脚本无条件 `.click()` 把它关掉了，
  症状是「宿主块没有译文」。受控 checkbox 的验证脚本必须先看 `checked` 再决定点不点。
- e2e 对照断言别用 `document.querySelector`（取第一个块）—— 第一个块可能是标题
  （标题本来就无缩进），对照失效。改用「存在缩进非 0 的普通段」。

## 下一迭代候选

1. 失败段落单点重试（I8 遗留，真实 Key 全文跑时必需）
2. 导出双语对照 Markdown/HTML（M3 项，给用户真实交付物）
3. 标签过滤视图 / 拖拽归类（R2 打磨）
4. macOS 签名/公证（需 Apple Developer 账号）+ Windows/Linux 三平台打包
