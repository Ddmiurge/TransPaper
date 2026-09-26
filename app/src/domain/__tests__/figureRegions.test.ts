import { describe, expect, it } from 'vitest';

import { figurePathBoxes, isEnclosedByGraphics } from '../figureRegions';
import type { BBox } from '../../types';

const box = (x: number, y: number, width: number, height: number): BBox => ({
  x,
  y,
  width,
  height,
});

describe('图形路径的聚类', () => {
  it('孤立的横线（页脚分隔线）不算图形', () => {
    // 单条横线如果被当成图形，附近的正文就有被误判为「图内文字」的风险。
    // 真正的图表总有几十条路径（线段、箭头、方框），靠规模区分。
    const paths = [box(50, 700, 200, 1)];
    expect(figurePathBoxes(paths)).toEqual([]);
  });

  it('数量足够的邻近路径算作图形', () => {
    const paths = [
      box(100, 100, 80, 40),
      box(100, 145, 80, 40),
      box(95, 100, 2, 85),
      box(183, 100, 2, 85),
      box(100, 190, 80, 1),
    ];
    expect(figurePathBoxes(paths)).toHaveLength(5);
  });

  it('分散在页面各处的零散路径不成簇，不构成图形', () => {
    // 五个相距很远的单条路径：互相之间不邻近，各自成簇、规模都是 1
    const paths = [
      box(20, 20, 10, 1),
      box(200, 200, 10, 1),
      box(400, 400, 10, 1),
      box(600, 600, 10, 1),
      box(800, 800, 10, 1),
    ];
    expect(figurePathBoxes(paths)).toEqual([]);
  });
});

describe('文字是否被图形夹住', () => {
  /** 一个带边框的方框，方框内部是文字位置 */
  // 方框内壁与文字只差 2–3px —— 这是图内标签的真实情形
  const framedBox = [box(117, 100, 156, 60), box(117, 100, 2, 60), box(271, 115, 2, 30)];

  it('方框内的文字算图内文字', () => {
    expect(isEnclosedByGraphics(box(120, 115, 150, 12), framedBox, 5)).toBe(true);
  });

  it('表格行（上下都有行线）算图内文字', () => {
    const rules = [
      box(50, 98, 400, 1),
      box(50, 118, 400, 1),
      box(50, 138, 400, 1),
    ];
    // 三行线构成两行表格，中间那行是数据
    expect(isEnclosedByGraphics(box(60, 102, 200, 12), rules, 5)).toBe(true);
  });

  it('正文段落不会被判为图内文字', () => {
    // 左侧是页边距、右侧是栏间空白，两边都没有图形
    expect(isEnclosedByGraphics(box(75, 300, 355, 12), framedBox, 5)).toBe(false);
  });

  it('位于图形下方但距离较远的文字不算图内文字', () => {
    // 这是真实踩过的坑：第 1 页有一段正文在图的下面，某条图形路径恰好从它左侧掠过。
    // 只要判据是「与图形相交」，整段正文就会被当成图内文字、保留为图像。
    // 加上距离限制后，图形与文字之间 20px 的常规留白就成了天然的分界线。
    const figure = [box(100, 100, 200, 60)];
    const textBelow = box(75, 190, 355, 12); // 与图下缘相距 30px
    expect(isEnclosedByGraphics(textBelow, figure, 5)).toBe(false);
  });

  it('位于两张图正中间的正文不会被误判（上下夹住的判据带距离限制）', () => {
    const above = [box(100, 100, 200, 40)]; // 上方的图，下缘 140
    const below = [box(100, 240, 200, 40)]; // 下方的图，上缘 240
    const text = box(100, 180, 200, 12); // 正文在 180–192，与两图各距 40/48px
    expect(isEnclosedByGraphics(text, [...above, ...below], 5)).toBe(false);
  });

  it('没有图形时一律返回 false', () => {
    expect(isEnclosedByGraphics(box(0, 0, 100, 10), [], 5)).toBe(false);
  });
});
