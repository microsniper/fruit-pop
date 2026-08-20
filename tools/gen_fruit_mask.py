#!/usr/bin/env python3
"""
从水果 PNG 的 alpha 通道烘出「可见区域采样掩码」，供 GameManager.isFruitBlocked 用。

为什么需要它：
  果子贴图按「最长边缩到 30px」摆放（createFruitVisual 里 diameter * 1.5），
  且贴图节点相对孔位上移了 2px。旧的遮挡判定固定按「以孔位为心、半径 10 的圆盘」
  撒 33 个点，完全不认贴图形状 —— 月牙香蕉、带梗樱桃、细长胡萝卜有大量采样点
  落在透明区（实测香蕉/樱桃只有约 52% 的点落在实体像素上），板子只要蹭到这些
  空白就被算成遮挡，于是出现「果子明明露着却点不动」。

本脚本做的事：
  在贴图局部坐标（原点 = 贴图中心，y 向上，单位 = 缩放后像素）撒 16x16 均匀网格
  （-15..15 步长 2，正好覆盖 30x30 的视觉范围），逐点查 alpha，把落在实体像素上的
  点打包成 16 行 × 16bit 位掩码，输出 64 位十六进制串。

  运行时只统计掩码内的点，分母就从「几何圆盘面积」变成「肉眼可见面积」，
  FRUIT_BLOCK_COVERAGE 这个比例对 15 种果子才是同一个意思。

用法：
  python3 tools/gen_fruit_mask.py
  把输出的 FRUIT_VISIBLE_MASK 整块替换进 GameManager.ts。
"""

import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
FRUITS_DIR = os.path.join(HERE, "..", "assets", "bundle_late", "fruits")

# 与 GameManager.FRUIT_MAP 保持一致（顺序按 FruitColor 枚举）
FRUIT_MAP = [
    ("red",     "Red Apple",     "苹果"),
    ("blue",    "Сorn",     "玉米"),      # 文件名首字是西里尔 С
    ("yellow",  "Lemon",         "柠檬"),
    ("pink",    "Peach",         "桃子"),
    ("orange",  "Orange",        "橘子"),
    ("green",   "Pear",          "鸭梨"),
    ("purple",  "Eggplant",      "茄子"),
    ("cyan",    "Carrot",        "胡萝卜"),
    ("crimson", "Pomegranate",   "石榴"),
    ("brown",   "Potato",        "土豆"),
    ("grape",   "Grape",         "葡萄"),
    ("banana",  "Banana",        "香蕉"),
    ("melon",   "Watermelon",    "西瓜"),
    ("cherry",  "Cherry",        "樱桃"),
    ("rainbow", "Rainbow Fruit", "彩虹果"),
]

VISUAL_MAX = 30.0                     # createFruitVisual 里 diameter(20) * 1.5
GRID = list(range(-15, 16, 2))        # 16 个取值，对称覆盖 30px
ALPHA_MIN = 8                         # alpha 高于此值算实体像素
COVERAGE = 0.20                       # 与 GameManager.FRUIT_BLOCK_COVERAGE 对齐，仅用于打印参考


def build_mask(path):
    """返回 (hex64, 可见点数)。位序：行 = gy 升序，行内 bit15..bit0 = gx 升序。"""
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    alpha = im.split()[3].load()
    scale = VISUAL_MAX / max(w, h)

    rows, visible = [], 0
    for gy in GRID:
        bits = 0
        for i, gx in enumerate(GRID):
            px = int(w / 2 + gx / scale)
            py = int(h / 2 - gy / scale)      # 图片 y 向下，网格 y 向上
            if 0 <= px < w and 0 <= py < h and alpha[px, py] > ALPHA_MIN:
                bits |= 1 << (15 - i)
                visible += 1
        rows.append(bits)
    return "".join("%04x" % r for r in rows), visible


def decode_count(hex64):
    """自检：把 hex 解回来数一遍，必须和烘的时候一致。"""
    return sum(bin(int(hex64[r * 4:r * 4 + 4], 16)).count("1") for r in range(16))


def main():
    print("    /**")
    print("     * 果子可见区域采样掩码（tools/gen_fruit_mask.py 从贴图 alpha 烘出，勿手改）。")
    print("     * 16 行 x 16bit：行 = 贴图局部 y 升序 -15..15 步长 2，行内 bit15..bit0 = x 升序。")
    print("     * 坐标原点 = 贴图中心（比孔位高 2px），单位 = 缩放后像素，覆盖 30x30 视觉范围。")
    print("     */")
    print("    private static readonly FRUIT_VISIBLE_MASK: Record<string, string> = {")

    stats = []
    for color, filename, cn in FRUIT_MAP:
        path = os.path.join(FRUITS_DIR, filename + ".png")
        if not os.path.exists(path):
            print("        // 缺图，跳过：%s (%s)" % (filename, cn))
            continue
        hex64, visible = build_mask(path)
        assert decode_count(hex64) == visible, "%s 掩码自检不一致" % filename
        need = -(-visible * 100 // int(COVERAGE * 100)) if False else int(visible * COVERAGE) + (
            1 if visible * COVERAGE % 1 else 0)
        print("        '%s': '%s', // %s 可见 %d 点，%.2f 阈值需 >=%d"
              % (color, hex64, cn, visible, COVERAGE, need))
        stats.append((cn, visible, need))

    print("    };")

    total = [s[1] for s in stats]
    print("\n// 共 %d 种；可见点 %d~%d，平均 %d"
          % (len(stats), min(total), max(total), sum(total) / len(total)))


if __name__ == "__main__":
    main()
