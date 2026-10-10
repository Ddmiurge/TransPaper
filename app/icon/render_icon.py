#!/usr/bin/env python3
"""生成 TransPaper 的 macOS 风格 App 图标全套。

严格按 macOS 图标规范：
  画布 1024pt 见方，图形区 824pt 居中（四周 100pt 留白），
  轮廓为超椭圆 n=5（squircle），透明画布。
输出：master 1024、@2x 各级、以及 iconutil 可吃的 iconset。
"""
import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

CANVAS = 1024
GRAPHIC = 824.0          # macOS 规范图形区边长
SS = 4                   # 超采样倍数
S = CANVAS * SS
HALF = GRAPHIC / 2.0 * SS
CX = CY = S / 2.0
R = HALF                 # 圆角矩形半宽（squircle 满铺 824）

GREEN_TOP = (0x11, 0x74, 0x5B)
INK_BOTTOM = (0x1E, 0x24, 0x22)
WHITE = (0xFF, 0xFF, 0xFF)
MINT = (0x7F, 0xD4, 0xB4)

STROKE = 22.0 * SS * (CANVAS / 824.0) / 1.0 * (824.0 / 1024.0) * (1024.0 / 824.0)
# 22pt 是相对 824pt 图形区的线宽，映射到 1024 画布像素：
STROKE = 22.0 / 824.0 * CANVAS * SS
THIN = STROKE * 0.55

OUT_DIR = os.path.dirname(os.path.abspath(__file__))


def squircle_points(n=800, exponent=5.0):
    """超椭圆 |x|^n + |y|^n = 1 的采样点（Apple squircle 近似，n≈5）。"""
    pts = []
    for i in range(n):
        t = 2.0 * math.pi * i / n
        ct, st = math.cos(t), math.sin(t)
        x = math.copysign(abs(ct) ** (2.0 / exponent), ct)
        y = math.copysign(abs(st) ** (2.0 / exponent), st)
        pts.append((CX + x * HALF, CY + y * HALF))
    return pts


def cubic(p0, p1, p2, p3, steps=90):
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0]
        y = u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1]
        out.append((x, y))
    return out


def build_master():
    # ---- 底色：垂直沉降渐变 ----
    grad = np.zeros((S, S, 3), dtype=np.float64)
    for c in range(3):
        top, bot = GREEN_TOP[c], INK_BOTTOM[c]
        grad[:, :, c] = np.linspace(top, bot, S)[:, None]
    base = Image.fromarray(grad.astype(np.uint8), "RGB").convert("RGBA")

    # ---- squircle 遮罩 ----
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).polygon(squircle_points(), fill=255)
    base.putalpha(mask)

    # ---- 线稿 ----
    draw = ImageDraw.Draw(base)

    def stroke(path, width, color, alpha=255):
        """沿路径密采样盖章 —— 避免折线连接的斜接毛刺。"""
        layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        r = width / 2.0
        col = color + (alpha,)
        pts = []
        # 先在亚像素精度下加密折线
        for i in range(len(path) - 1):
            x0, y0 = path[i]
            x1, y1 = path[i + 1]
            seg = max(2, int(math.hypot(x1 - x0, y1 - y0) / (r * 0.3)))
            for k in range(seg):
                t = k / seg
                pts.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
        pts.append(path[-1])
        for (x, y) in pts:
            d.ellipse([x - r, y - r, x + r, y + r], fill=col)
        base.alpha_composite(layer)

    def mirror(path):
        return [(S - x, y) for (x, y) in path]

    def q(p0, p1, p2, steps=120):
        """二次贝塞尔。"""
        out = []
        for i in range(steps + 1):
            t = i / steps
            u = 1 - t
            out.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                        u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
        return out

    U = lambda v: v / 1024.0 * S
    # 光学重心校正：几何居中偏上，整体仅沿纵轴下移（不影响左右对称）
    DY = 34 / 1024.0 * S
    VX = lambda v: U(v)
    VY = lambda v: U(v) + DY
    spine_top = (VX(512), VY(374))
    spine_bot = (VX(512), VY(622))

    # 对开页：顶缘上扬的弧 + 垂直外缘 + 严格水平的底缘
    left_page = (
        q(spine_top, (VX(392), VY(300)), (VX(284), VY(330)))
        + [(VX(284), VY(622))]
        + [(VX(284), VY(622)), (VX(512), VY(622))]
    )
    right_page = mirror(left_page)
    stroke(left_page, STROKE, WHITE)
    stroke(right_page, STROKE, WHITE)
    stroke([(VX(512), VY(374)), (VX(512), VY(622))], STROKE, WHITE)

    # 页内文字行：左页四行白，右页后两行薄荷绿 = 译文
    ys = [428, 476, 524, 572]
    for i, yv in enumerate(ys):
        y = VY(yv)
        x0, x1 = VX(322), VX(474)
        stroke([(x0, y), (x1, y)], THIN, WHITE, 150)
        if i >= 2:
            stroke([(S - x0, y), (S - x1, y)], THIN, MINT, 190)
        else:
            stroke([(S - x0, y), (S - x1, y)], THIN, WHITE, 150)

    return base.resize((CANVAS, CANVAS), Image.LANCZOS)


def write_set(master):
    master_path = os.path.join(OUT_DIR, "transpaper-icon-1024.png")
    master.save(master_path)
    iconset = os.path.join(OUT_DIR, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)

    specs = [
        ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
    ]
    for name, px in specs:
        img = master if px == CANVAS else master.resize((px, px), Image.LANCZOS)
        img.save(os.path.join(iconset, name))

    icns = os.path.join(OUT_DIR, "icon.icns")
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", icns], check=True)

    # Tauri 需要的命名
    tauri = {
        "icon.png": 512,
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
    }
    os.makedirs(os.path.join(OUT_DIR, "tauri"), exist_ok=True)
    for name, px in tauri.items():
        master.resize((px, px), Image.LANCZOS).save(
            os.path.join(OUT_DIR, "tauri", name))
    subprocess.run(["cp", icns, os.path.join(OUT_DIR, "tauri", "icon.icns")],
                   check=True)
    return master_path, icns


if __name__ == "__main__":
    m = build_master()
    mp, icns = write_set(m)
    print("master:", mp)
    print("icns  :", icns)
