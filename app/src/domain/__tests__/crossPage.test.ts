import { describe, expect, it } from 'vitest';

import {
  endsOpen,
  isContinuation,
  mergeMasked,
  paragraphTailInfoOf,
  startsContinuation,
} from '../crossPage';
import { unmaskInlineMath } from '../inlineMath';
import type { Block } from '../../types';

/** 构造一个最小可用的块，只填判定用到的字段 */
function makeBlock(overrides: Partial<Block> & { id: string; text: string }): Block {
  return {
    pageIndex: 0,
    columnIndex: 0,
    readOrder: 0,
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    lineIds: [],
    spans: [],
    fontSize: 10,
    fontScale: 1,
    bold: false,
    headingLevel: 0,
    isBodyText: true,
    widthRatio: 1,
    gapsPerLine: 0,
    translatable: true,
    formula: false,
    nonTranslatableReason: null,
    figureReason: null,
    ...overrides,
  };
}

describe('endsOpen（尾部是否句子未完）', () => {
  it('字母/数字/逗号/分号/连接符收尾 → 未完', () => {
    expect(endsOpen('the residual function is defined as')).toBe(true);
    expect(endsOpen('results are shown in Table')).toBe(true);
    expect(endsOpen('accuracy improves by 3.2')).toBe(true);
    expect(endsOpen('both precision, and')).toBe(true);
    expect(endsOpen('the encoder; moreover')).toBe(true);
    expect(endsOpen('a state-of-the-art')).toBe(true);
  });

  it('句号/问叹号/冒号/引号括号收尾 → 可以结束', () => {
    expect(endsOpen('the residual function is defined as follows.')).toBe(false);
    expect(endsOpen('what does this mean?')).toBe(false);
    expect(endsOpen('the results are striking!')).toBe(false);
    expect(endsOpen('we evaluate on three tasks:')).toBe(false);
    expect(endsOpen('as shown in Eq. (3)')).toBe(false);
    expect(endsOpen('says the paper."')).toBe(false);
    expect(endsOpen('')).toBe(false);
  });

  it('尾部空白不影响判定', () => {
    expect(endsOpen('defined as   ')).toBe(true);
    expect(endsOpen('defined as follows.  ')).toBe(false);
  });
});

describe('startsContinuation（头部是否延续）', () => {
  it('小写字母/逗号/分号开头 → 延续', () => {
    expect(startsContinuation('y = F(x) + x, where x is the input')).toBe(true);
    expect(startsContinuation('where x is the input')).toBe(true);
    expect(startsContinuation(', and the experiments confirm this')).toBe(true);
    expect(startsContinuation('the input…')).toBe(true);
  });

  it('大写/编号/数字开头 → 不是延续', () => {
    expect(startsContinuation('We evaluate on three datasets.')).toBe(false);
    expect(startsContinuation('(1) Foo bar')).toBe(false);
    expect(startsContinuation('3. Method')).toBe(false);
    expect(startsContinuation('3 we observe a drop')).toBe(false);
    expect(startsContinuation('Figure 5: architecture')).toBe(false);
    expect(startsContinuation('')).toBe(false);
  });
});

describe('paragraphTailInfoOf（页尾候选）', () => {
  it('取阅读顺序最后一个可译正文块，跳过页码与参考文献', () => {
    const blocks = [
      makeBlock({ id: 'b0', text: 'First paragraph ends here.' }),
      makeBlock({ id: 'b1', text: 'References', translatable: false, nonTranslatableReason: 'references' }),
      makeBlock({ id: 'b2', text: '[1] Some citation', translatable: false, nonTranslatableReason: 'references' }),
      makeBlock({ id: 'b3', text: '12', translatable: false, nonTranslatableReason: 'numeric' }),
    ];
    const tail = paragraphTailInfoOf(blocks);
    expect(tail?.blockId).toBe('b0');
  });

  it('标题与行间公式不能成为尾部候选', () => {
    const blocks = [
      makeBlock({ id: 'b0', text: 'Body paragraph.' }),
      makeBlock({ id: 'b1', text: '4 Experiments', headingLevel: 2 }),
      makeBlock({ id: 'b2', text: 'y = F(x) + x', formula: true, translatable: false }),
    ];
    const tail = paragraphTailInfoOf(blocks);
    expect(tail?.blockId).toBe('b0');
  });

  it('没有可译正文块时返回 null', () => {
    expect(paragraphTailInfoOf([])).toBeNull();
    expect(paragraphTailInfoOf([makeBlock({ id: 'b0', text: '9', translatable: false })])).toBeNull();
  });

  it('尾部携带行内公式的占位信息', () => {
    const blocks = [
      makeBlock({
        id: 'b0',
        text: 'the score is f(x) and',
        spans: [{ start: 13, end: 17, bold: false, italic: false, math: true }],
      }),
    ];
    const tail = paragraphTailInfoOf(blocks);
    expect(tail?.masked).toBe('the score is [[MATH_0]] and');
    expect(tail?.pieces).toHaveLength(1);
    expect(tail?.pieces[0].text).toBe('f(x)');
  });
});

describe('isContinuation（接续判定）', () => {
  const tail = (text: string) => ({
    blockId: 'p0-c1-b3',
    text,
    masked: text,
    pieces: [],
  });

  it('尾部未完 + 小写开头 → 合并', () => {
    expect(
      isContinuation(
        tail('the residual function is defined as'),
        makeBlock({ id: 'h', text: 'y = F(x) + x, where x is the input' })
      )
    ).toBe(true);
  });

  it('尾部句号收尾 → 不合并（哪怕头部小写）', () => {
    expect(
      isContinuation(
        tail('The experiments confirm this.'),
        makeBlock({ id: 'h', text: 'more details are in the appendix' })
      )
    ).toBe(false);
  });

  it('头部大写/编号开头 → 不合并（哪怕尾部未完）', () => {
    expect(
      isContinuation(
        tail('the results hold for both settings'),
        makeBlock({ id: 'h', text: 'We further study…' })
      )
    ).toBe(false);
    expect(
      isContinuation(
        tail('the results hold for both settings'),
        makeBlock({ id: 'h', text: '3. Method' })
      )
    ).toBe(false);
  });

  it('头部是标题/公式/不可译块 → 一律不合并', () => {
    const openTail = tail('…which we define as');
    expect(
      isContinuation(openTail, makeBlock({ id: 'h', text: 'results', headingLevel: 1 }))
    ).toBe(false);
    expect(
      isContinuation(openTail, makeBlock({ id: 'h', text: 'where x', formula: true, translatable: false }))
    ).toBe(false);
    expect(
      isContinuation(
        openTail,
        makeBlock({ id: 'h', text: '[1] citation', translatable: false, nonTranslatableReason: 'references' })
      )
    ).toBe(false);
  });

  it('缺尾或缺头 → 不合并', () => {
    expect(isContinuation(null, makeBlock({ id: 'h', text: 'where x' }))).toBe(false);
    expect(isContinuation(tail('defined as'), null)).toBe(false);
  });
});

describe('mergeMasked（占位文本合并）', () => {
  it('尾部占位符重编号，避免与头部冲突', () => {
    const merged = mergeMasked(
      'score is [[MATH_0]] and',
      [{ marker: '[[MATH_0]]', text: 'f(x)' }],
      '[[MATH_0]] works on [[MATH_1]]',
      [
        { marker: '[[MATH_0]]', text: 'g(y)' },
        { marker: '[[MATH_1]]', text: 'z' },
      ]
    );
    expect(merged.masked).toBe('score is [[MATH_2]] and [[MATH_0]] works on [[MATH_1]]');
    expect(merged.pieces.map((p) => p.marker)).toEqual([
      '[[MATH_2]]',
      '[[MATH_0]]',
      '[[MATH_1]]',
    ]);
  });

  it('合并后回填：两段的公式都恢复原样', () => {
    const merged = mergeMasked(
      'score is [[MATH_0]] and',
      [{ marker: '[[MATH_0]]', text: 'f(x)' }],
      '[[MATH_0]] plus [[MATH_1]]',
      [
        { marker: '[[MATH_0]]', text: 'g(y)' },
        { marker: '[[MATH_1]]', text: 'W_i' },
      ]
    );
    const { text, missing } = unmaskInlineMath('得分是 [[MATH_2]] 与 [[MATH_0]] 加 [[MATH_1]]', merged.pieces);
    expect(missing).toBe(0);
    expect(text).toBe('得分是 f(x) 与 g(y) 加 W_i');
  });

  it('尾部占位符重编号不会误伤多位编号（[[MATH_1]] vs [[MATH_11]]）', () => {
    const merged = mergeMasked(
      'a [[MATH_1]] b',
      [
        { marker: '[[MATH_0]]', text: 'x' },
        { marker: '[[MATH_1]]', text: 'y' },
      ],
      'c',
      Array.from({ length: 11 }, (_, i) => ({ marker: `[[MATH_${i}]]`, text: `t${i}` }))
    );
    // 尾部偏移 11：[[MATH_1]] → [[MATH_12]]，且不能把 [[MATH_11]] 的字符撞坏
    expect(merged.masked).toBe('a [[MATH_12]] b c');
  });

  it('无公式时原样拼接（中间一个空格）', () => {
    const merged = mergeMasked('first half', [], 'second half', []);
    expect(merged.masked).toBe('first half second half');
    expect(merged.pieces).toHaveLength(0);
  });
});
