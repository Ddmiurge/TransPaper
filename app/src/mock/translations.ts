/**
 * 占位译文（尚未接入真实模型时使用）
 *
 * ── 为什么要写得不那么"占位" ──
 * 最初的做法是把一句固定文本按原文长度截断重复。后果有两个：
 *   1. 截断发生在句子中间，读起来像乱码（"……长度按原文成比例生"）
 *   2. 同一句在一页里重复十几遍，**排版效果完全无法评估** —— 目测到的是
 *      "一堆重复的字"，而不是真实译文下的行距、缩进、回行表现
 *
 * 因此这里改成：从一组学术语体的句子中，按原文的确定性哈希选取起点，
 * 拼接**完整句子**直到长度接近目标，绝不截断到句子中间。
 *
 * 比例取 0.5，配合「超标即停」的拼接策略，实际产出平均约 0.55 倍 ——
 * 这正是中译英的粗略字符数比。真实值需接入模型后校准。
 */

import { hashText } from '../domain/translation';

const SENTENCES = [
  '实验结果表明，该方法在标准数据集上取得了优于基线的性能。',
  '我们在本节中分析该现象背后的原因，并给出两种可能的解释。',
  '为了验证这一假设，我们在多个规模上重复了实验，结论保持一致。',
  '与已有工作相比，本文的主要贡献在于在简化结构的同时保持精度。',
  '值得注意的是，当网络深度继续增加时，训练误差反而出现上升。',
  '这种退化现象并非由过拟合引起，而是优化难度随深度增加所致。',
  '我们在下文中给出该问题的形式化描述，并讨论它与相关工作的区别。',
  '上述结论在图像分类与目标检测两个任务上均得到了验证。',
  '该设计的一个直接好处是参数量与计算量的增长都落在可接受范围内。',
  '我们把这一改进归因于梯度传播路径的缩短，后续实验也支持这一判断。',
  '需要说明的是，本文的方法并不依赖特定的网络结构，具有较好的通用性。',
  '综合来看，该方案在精度、速度与实现复杂度三者之间取得了较好的平衡。',
];

const LENGTH_RATIO = 0.5;

export function mockTranslate(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) return '';

  const targetLength = Math.max(18, Math.round(trimmed.length * LENGTH_RATIO));
  // 复用 domain/translation 的 hashText（审查 B5：两份 FNV-1a 合并为一份），
  // 取 64 位哈希的低位做起点 —— 同一段原文永远得到同一段占位译文
  const start = Number(BigInt('0x' + hashText(trimmed).slice(-8)) % BigInt(SENTENCES.length));

  let output = '';
  // 拼接完整句子，直到接近目标长度。
  // 但**不能无脑拼到超过目标为止** —— 一句约 26 字，若目标只有 30 字，
  // 拼两句就是 52 字（超出一倍），整页高度会被虚增，排版评估随之失真。
  // 因此再加一句会明显超标时就停。
  for (let i = 0; i < SENTENCES.length; i += 1) {
    const next = SENTENCES[(start + i) % SENTENCES.length];
    if (output.length > 0 && output.length + next.length > targetLength * 1.15) break;
    output += next;
    if (output.length >= targetLength) break;
  }
  return output;
}
