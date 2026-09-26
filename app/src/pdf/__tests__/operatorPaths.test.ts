import { describe, expect, it } from 'vitest';

import { geometryBoxesFromOperators, pathBoxesFromOperators, type OperatorIds } from '../operatorPaths';

/**
 * 这里的算子编号是**自造**的：`pathBoxesFromOperators` 刻意不 import pdf.js，
 * 编号由调用方传入，所以测试可以随便定。这样这个模块能在 Node 里纯逻辑地测，
 * 不必拉起 pdf.js 的浏览器构建。
 */
const IDS: OperatorIds = {
  save: 1,
  restore: 2,
  transform: 3,
  paintFormXObjectBegin: 4,
  paintFormXObjectEnd: 5,
  constructPath: 6,
  paintImageXObject: 7,
  paintInlineImageXObject: 8,
  paintImageMaskXObject: 9,
};

/** 单位视口变换：PDF 用户空间 === 视口坐标 */
const IDENTITY_VIEWPORT = [1, 0, 0, 1, 0, 0];

/** 构造一次 constructPath 的 args：[ops, 坐标, minMax] */
function path(x0: number, y0: number, x1: number, y1: number) {
  return [null, null, new Float32Array([x0, y0, x1, y1])];
}

function ops(entries: Array<[number, any]>) {
  return {
    fnArray: entries.map((e) => e[0]),
    argsArray: entries.map((e) => e[1]),
  };
}

describe('pathBoxesFromOperators · 矩阵累乘方向', () => {
  /**
   * 这一组测试守的是一个**代价很大的历史 bug**：CTM 累乘写成了右乘。
   *
   * PDF 的 `cm` 语义是 `CTM_new = M × CTM_old`（左乘）。写成右乘后，
   * **单一变换时两种写法结果相同**（`I × M === M × I`），所以问题被掩盖了；
   * 只有多层嵌套（平移叠缩放）才暴露 —— 而真实论文里图形恰好常这么画。
   *
   * 症状是整页图形的位置偏移（第 1 页图 1 的路径被算到左栏，实际在右栏），
   * 进而让「文字是否落在图形区域内」的判定在那些页面上完全失效。
   */

  it('单个平移：与累乘方向无关，两种写法都对', () => {
    const list = ops([
      [IDS.transform, [1, 0, 0, 1, 100, 200]],
      [IDS.constructPath, path(0, 0, 10, 20)],
    ]);
    const boxes = pathBoxesFromOperators(list, IDENTITY_VIEWPORT, IDS);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ x: 100, y: 200, width: 10, height: 20 });
  });

  it('平移后再缩放：原点落在平移量上，尺寸被缩放（左乘语义）', () => {
    // 内容流：`1 0 0 1 100 200 cm` 然后 `2 0 0 2 0 0 cm`
    //   CTM = S × T
    //   点 (0,0) → 先被 S 缩放仍是 (0,0) → 再被 T 平移到 (100, 200)
    // 如果写成右乘（CTM = T × S），会得到 (200, 400) —— 差了一整个缩放倍率。
    const list = ops([
      [IDS.transform, [1, 0, 0, 1, 100, 200]],
      [IDS.transform, [2, 0, 0, 2, 0, 0]],
      [IDS.constructPath, path(0, 0, 1, 1)],
    ]);
    const [box] = pathBoxesFromOperators(list, IDENTITY_VIEWPORT, IDS);
    expect(box.x).toBeCloseTo(100, 6);
    expect(box.y).toBeCloseTo(200, 6);
    expect(box.width).toBeCloseTo(2, 6);
    expect(box.height).toBeCloseTo(2, 6);
  });

  it('嵌套层级越深，累积偏差越大（用真实论文的三层结构）', () => {
    // 复现第 1 页图 1 的变换链（简化量级）：
    //   平移 (308.9, 489.3) → 缩放 0.73 → form 矩阵（单位）
    // 正确的 form 原点应当落在「平移量」上，不会被缩放乘掉。
    const list = ops([
      [IDS.transform, [1, 0, 0, 1, 308.9, 489.3]],
      [IDS.transform, [0.73143, 0, 0, 0.73143, 0, 0]],
      [IDS.paintFormXObjectBegin, [null, null]],
      [IDS.constructPath, path(0, 0, 172, 107.1)],
      [IDS.paintFormXObjectEnd, null],
    ]);
    const [box] = pathBoxesFromOperators(list, IDENTITY_VIEWPORT, IDS);
    expect(box.x).toBeCloseTo(308.9, 4);
    expect(box.y).toBeCloseTo(489.3, 4);
    // 尺寸被 0.73143 缩放
    expect(box.width).toBeCloseTo(172 * 0.73143, 4);
    expect(box.height).toBeCloseTo(107.1 * 0.73143, 4);
  });
});

describe('pathBoxesFromOperators · save / restore', () => {
  it('restore 之后回到 save 时的矩阵状态', () => {
    const list = ops([
      [IDS.transform, [1, 0, 0, 1, 100, 200]],
      [IDS.save, null],
      [IDS.transform, [2, 0, 0, 2, 0, 0]],
      [IDS.constructPath, path(0, 0, 1, 1)], // 缩放后的空间
      [IDS.restore, null],
      [IDS.constructPath, path(0, 0, 1, 1)], // 回到只有平移的空间
    ]);
    const boxes = pathBoxesFromOperators(list, IDENTITY_VIEWPORT, IDS);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({ x: 100, y: 200, width: 2, height: 2 });
    expect(boxes[1]).toMatchObject({ x: 100, y: 200, width: 1, height: 1 });
  });

  it('restore 多于 save 时不崩溃（容错）', () => {
    const list = ops([
      [IDS.restore, null],
      [IDS.transform, [1, 0, 0, 1, 5, 5]],
      [IDS.constructPath, path(0, 0, 1, 1)],
    ]);
    const [box] = pathBoxesFromOperators(list, IDENTITY_VIEWPORT, IDS);
    expect(box).toMatchObject({ x: 5, y: 5 });
  });
});

describe('pathBoxesFromOperators · 视口变换', () => {
  it('最后一个矩阵是视口变换（v_viewport = v_user × CTM × viewportTransform）', () => {
    // 真实视口变换：scale 1.5 + y 轴翻转（PDF 原点在左下，视口原点在左上）
    const viewport = [1.5, 0, 0, -1.5, 0, 1188];
    const list = ops([[IDS.constructPath, path(0, 0, 100, 100)]]);
    const [box] = pathBoxesFromOperators(list, viewport, IDS);
    // x: 0 → 0, 100 → 150
    expect(box.x).toBeCloseTo(0, 6);
    expect(box.width).toBeCloseTo(150, 6);
    // y 轴翻转：PDF y=0 落在视口底部 1188，PDF y=100 落在 1188-150=1038
    expect(box.y).toBeCloseTo(1038, 6);
    expect(box.y + box.height).toBeCloseTo(1188, 6);
  });
});

describe('pathBoxesFromOperators · 边界情况', () => {
  it('minMax 缺失或含非有限值时跳过该条路径', () => {
    const list = ops([
      [IDS.constructPath, [null, null, null]],
      [IDS.constructPath, [null, null, new Float32Array([0, 0, NaN, 10])]],
      [IDS.constructPath, path(0, 0, 10, 10)],
    ]);
    const boxes = pathBoxesFromOperators(list, IDENTITY_VIEWPORT, IDS);
    expect(boxes).toHaveLength(1);
  });

  it('没有路径时返回空数组', () => {
    const list = ops([[IDS.save, null], [IDS.restore, null]]);
    expect(pathBoxesFromOperators(list, IDENTITY_VIEWPORT, IDS)).toEqual([]);
  });
});

describe('geometryBoxesFromOperators · 位图放置框', () => {
  /**
   * ACL 等出版排版的图表是**整张嵌入的 PNG/JPEG**，全页矢量路径为 0。
   * 不提取位图放置框，图表检测对这类论文完全失效
   * （实测：附录整页图表的标签全部漏进正文流）。
   *
   * PDF 语义：位图绘制在**单位正方形**上，由当时的 CTM 摆到页面位置。
   * 所以放置框 = 单位正方形 × CTM × 视口。
   */
  it('位图放置框 = 单位正方形经 CTM 变换', () => {
    const list = ops([
      [IDS.transform, [2, 0, 0, 2, 100, 200]],
      [IDS.paintImageXObject!, ['Im1', 300, 200]],
    ]);
    const { paths, images } = geometryBoxesFromOperators(list, IDENTITY_VIEWPORT, IDS);
    // 单位正方形 (0,0)-(1,1) 过「缩放2 + 平移(100,200)」→ (100,200)-(102,202)
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ x: 100, y: 200, width: 2, height: 2 });
    // 位图不算矢量路径
    expect(paths).toHaveLength(0);
  });

  it('form 内的位图继承 form 矩阵（进 form 压栈、出 form 弹栈）', () => {
    const list = ops([
      [IDS.save, null],
      [IDS.paintFormXObjectBegin, [[1, 0, 0, 1, 50, 60]]],
      [IDS.transform, [3, 0, 0, 3, 0, 0]],
      [IDS.paintInlineImageXObject!, [null]],
      [IDS.paintFormXObjectEnd, null],
      [IDS.restore, null],
      // form 外的位图不受 form 矩阵影响
      [IDS.paintImageXObject!, ['Im2', 10, 10]],
    ]);
    const { images } = geometryBoxesFromOperators(list, IDENTITY_VIEWPORT, IDS);
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({ x: 50, y: 60, width: 3, height: 3 });
    expect(images[1]).toMatchObject({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('pathBoxesFromOperators 兼容包装只返回矢量路径', () => {
    const list = ops([
      [IDS.transform, [2, 0, 0, 2, 100, 200]],
      [IDS.paintImageXObject!, ['Im1', 300, 200]],
      [IDS.constructPath, path(0, 0, 10, 20)],
    ]);
    const boxes = pathBoxesFromOperators(list, IDENTITY_VIEWPORT, IDS);
    expect(boxes).toHaveLength(1);
    // 路径坐标也要过 CTM：(0,0)-(10,20) × 缩放2 + 平移 → 宽 20 高 40
    expect(boxes[0]).toMatchObject({ x: 100, y: 200, width: 20, height: 40 });
  });
});
