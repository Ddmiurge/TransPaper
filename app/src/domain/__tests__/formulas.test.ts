import { describe, expect, it } from 'vitest';

import { markFormulas } from '../formulas';
import type { Block } from '../../types';

/** 造一个块。只填判定用得上的字段，其余给中性默认值 */
function block(id: string, text: string, overrides: Partial<Block> = {}): Block {
  return {
    id,
    pageIndex: 0,
    columnIndex: 0,
    readOrder: 0,
    bbox: { x: 0, y: 0, width: 300, height: 20 },
    lineIds: ['l0'],
    text,
    spans: [],
    fontSize: 15,
    fontScale: 1,
    bold: false,
    headingLevel: 0,
    isBodyText: true,
    translatable: true,
    nonTranslatableReason: null,
    formula: false,
    widthRatio: 1,
    gapsPerLine: 0,
    figureReason: null,
    ...overrides,
  };
}

describe('markFormulas', () => {
  it('带编号的行间公式被识别（实测 ResNet 第 3 页）', () => {
    // 这两行是从真实 PDF 里提取出来的原文 —— 包括下标拍平后的形态
    const blocks = [
      block('b0', 'y = F(x, {Wi}) + x. (1)'),
      block('b1', 'y = F(x, {Wi}) + Wsx. (2)'),
    ];
    const n = markFormulas(blocks);
    expect(n).toBe(2);
    expect(blocks[0].formula).toBe(true);
    expect(blocks[0].translatable).toBe(false);
    expect(blocks[0].nonTranslatableReason).toBe('formula');
  });

  it('以 (1) 结尾的普通句子不误判 —— 长单词是防线', () => {
    // 「as shown in Table 3 (1).」这类句子也以编号结尾。
    // 把它们挡住的是「正常句子有大量 ≥3 字母单词」这一形态差异。
    const blocks = [
      block('b0', 'The results are compared against several baselines (1).'),
      block('b1', 'Similar phenomena are also observed on ImageNet classification (1).'),
    ];
    expect(markFormulas(blocks)).toBe(0);
  });

  it('无编号的单行公式也能识别（equation* 环境）', () => {
    const blocks = [block('b0', 'x = y + z − w')];
    expect(markFormulas(blocks)).toBe(1);
  });

  it('正文段落里哪怕混有符号也不会被无编号判据误伤', () => {
    // 无编号判据要求零长单词 + 高密度 —— 正文段落两者都不满足
    const blocks = [block('b0', 'F(x) = 0 holds for every x in the dataset')];
    expect(markFormulas(blocks)).toBe(0);
  });

  it('参考文献、页码等已标记的块不重复处理', () => {
    const blocks = [
      block('b0', '[1] A. Author. Some paper (1).', {
        translatable: false,
        nonTranslatableReason: 'references',
      }),
      block('b1', '9', { translatable: false, nonTranslatableReason: 'numeric' }),
    ];
    expect(markFormulas(blocks)).toBe(0);
    expect(blocks[0].nonTranslatableReason).toBe('references');
  });

  it('标题不是公式', () => {
    const blocks = [block('b0', '3.2. Identity Mapping by Shortcuts', { headingLevel: 1 })];
    expect(markFormulas(blocks)).toBe(0);
  });

  it('多行块漏判时保持原样（宁可漏判不可误判）', () => {
    // align 环境的多行公式理想情况应整体识别；但行数多、混入英文时，
    // 判据宁可放弃 —— 误判会把正文段落变成图像，代价远大于漏判。
    const blocks = [block('b0', 'y = F(x) + z. (3) where F is the residual mapping', {
      lineIds: ['l0', 'l1'],
    })];
    expect(markFormulas(blocks)).toBe(0);
  });

  it('极简无编号单行等式也能识别（a = b + c）', () => {
    // 旧阈值 mathDensity ≥ 0.4 会漏掉这类符号密度约 0.33 的极简等式，
    // 结果它们被整段送去翻译。改用「强运算符密度 ≥0.3 + 零长单词」后认出。
    const blocks = [block('b0', 'a = b + c')];
    expect(markFormulas(blocks)).toBe(1);
    expect(blocks[0].formula).toBe(true);
    expect(blocks[0].translatable).toBe(false);
  });

  it('只有圆括号、没有强运算符的文本不误判（Eq. (1)）', () => {
    // 强密度排除单纯括号：否则 Eq. (1) 会被当成无编号公式。
    const blocks = [block('b0', 'Eq. (1)')];
    expect(markFormulas(blocks)).toBe(0);
  });

  it('被拆成多行的无编号等式也能识别', () => {
    // align 环境被拆成多行、且首行未被认出时，靠「零长单词 + 多行强密度」兜底。
    const blocks = [block('b0', 'x = y z = w', { lineIds: ['l0', 'l1'] })];
    expect(markFormulas(blocks)).toBe(1);
    expect(blocks[0].formula).toBe(true);
    expect(blocks[0].translatable).toBe(false);
  });

  it('多行正文段落不误判（零长单词防线）', () => {
    // 多行判定放宽后，真正的正文段落仍被长单词挡在门外
    const blocks = [block('b0', 'The method works well across all datasets', {
      lineIds: ['l0', 'l1'],
    })];
    expect(markFormulas(blocks)).toBe(0);
  });
});
