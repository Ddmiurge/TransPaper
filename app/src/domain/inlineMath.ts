import type { TextSpan } from '../types';

/**
 * 行内公式的占位与回填（I19）—— 让「公式不被翻译」在**结构层**成立。
 *
 * ── 为什么只靠提示词不够 ──
 * I17 先把提示词改成了「行内数学逐字符照抄」，但那是**约束模型**：
 * 模型仍会看到 `f(x) = y` 的字符，仍可能把 `=` 写成「等于」、
 * 把 `x` 译掉、或在公式里插入空格。学术阅读里这类细微变形最难发现。
 *
 * 结构层的做法是**根本不把公式交给模型**：
 *   送译前：`…其中 f(x) = y 且…` → `…其中 [[MATH_0]] 且…`
 *   译后回填：`…其中 [[MATH_0]] 且…` → `…其中 f(x) = y 且…`
 * 模型无从改动它，公式字符的完整性由代码保证，而不是由模型的自律保证。
 *
 * ── 为什么标记用 ASCII ──
 * 早期考虑过 `⟦0⟧` 这类 Unicode 书签字符，但模型对罕见 Unicode 的复现率
 * 明显低于 `[[MATH_0]]` 这种「看起来像模板占位」的 ASCII 串 ——
 * 占位符一旦被模型改名，回填就会失败（下面有兜底，但等于白保护）。
 */

const MARKER_PREFIX = '[[MATH_';
const MARKER_SUFFIX = ']]';

/** 一段被占位保护起来的原文 */
export interface MathPiece {
  marker: string;
  /** 原公式文本（回填时用） */
  text: string;
}

/**
 * 行内公式在块文本中的区间（已排序、已去重叠）。
 *
 * 去重叠是必须的：appendSpan 的合并规则跨不过正文，
 * 于是「相邻的两个公式项之间夹了一个普通字符」时可能产出交叠区间，
 * 重复占位会让回填顺序错乱。
 */
export function mathRanges(text: string, spans: TextSpan[]): Array<{ start: number; end: number }> {
  const ranges = spans
    .filter((s) => s.math)
    .map((s) => ({ start: Math.max(0, s.start), end: Math.min(text.length, s.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r.start < last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * 把行内公式替换成占位标记，得到「送翻译的原文」。
 *
 * 区间直接来自 spans 的偏移 —— 不靠文本回找，
 * 否则同一段里出现两次相同的 `x` 时会定位到错的那次。
 * 无公式时原样返回（不改变缓存键、不影响任何既有行为）。
 */
export function maskInlineMath(text: string, spans: TextSpan[]): { masked: string; pieces: MathPiece[] } {
  const ranges = mathRanges(text, spans);
  if (ranges.length === 0) return { masked: text, pieces: [] };

  const pieces: MathPiece[] = ranges.map((r, i) => ({
    marker: `${MARKER_PREFIX}${i}${MARKER_SUFFIX}`,
    text: text.slice(r.start, r.end),
  }));

  let out = '';
  let cursor = 0;
  for (let i = 0; i < ranges.length; i += 1) {
    out += text.slice(cursor, ranges[i].start) + pieces[i].marker;
    cursor = ranges[i].end;
  }
  out += text.slice(cursor);
  return { masked: out, pieces };
}

/**
 * 回填：把译文里的占位标记换回原公式。
 *
 * 兜底策略是**保守**的：模型若丢了某个标记，就跳过它（译文里那段公式消失），
 * 并返回 missing 计数交给质量告警 —— 不因为回填不完整就整段判失败。
 * （与 ADR-011「告警不拒绝」同一条原则：误判比漏判更伤信任。）
 */
export function unmaskInlineMath(
  translated: string,
  pieces: MathPiece[]
): { text: string; missing: number } {
  if (pieces.length === 0) return { text: translated, missing: 0 };
  let out = translated;
  let missing = 0;
  for (const piece of pieces) {
    if (!out.includes(piece.marker)) {
      missing += 1;
      continue;
    }
    out = out.split(piece.marker).join(piece.text);
  }
  return { text: out, missing };
}
