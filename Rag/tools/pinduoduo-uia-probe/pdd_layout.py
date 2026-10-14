#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""拼多多客服聊天区「版面识别」：按颜色检测消息气泡，从结构上排除分隔线/提示语。

原理
----
聊天区里只有两种东西带"气泡底色"：
- **客户消息**：白色卡片（页面底色是浅灰 #F7F8F9，白色 >=252 即可分辨）；
- **我方消息**：浅蓝气泡（b - r > 20 且 b 高）。
时间分隔线、"已读/未读"、来自手机端、横幅提示语都是灰底灰字——**不属于任何气泡**，
因此按颜色取气泡框后再对每个框单独 OCR，杂音从物理上进来不了。

坐标：输入图是 2x 截图（2500x1580）。返回的框同为 2x 坐标。
"""

from __future__ import annotations

import os
from typing import Optional

CHAT_X = (0.295, 0.70)   # 聊天列左边界实测 0.288W（0.295 起避开左侧列表的时间标签）
CHAT_Y = (0.255, 0.665)  # 消息带实测：顶部横幅止于 0.25H，底部提示条起于 0.70H
MIN_W, MIN_H = 36, 22      # 过滤图标/徽标等小色块
ROW_MIN = 30               # 短气泡（2字）也要能过


def detect_bubbles(img) -> list[dict]:
    """返回 [{x0,y0,x1,y1,direction}]（2x 坐标，按 y 排序）。"""
    import numpy as np

    W, H = img.size
    x0 = int(CHAT_X[0] * W); x1 = int(CHAT_X[1] * W)
    y0 = int(CHAT_Y[0] * H); y1 = int(CHAT_Y[1] * H)
    crop = img.crop((x0, y0, x1, y1))
    arr = np.asarray(crop).astype(np.int16)
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    blue = (b > 225) & ((b - r) > 18) & (g > 200)
    white = (r >= 253) & (g >= 253) & (b >= 253)
    mask = blue | white
    # 3x3 腐蚀：半透明水印/抗锯齿的散点被消除，只留连续的气泡面
    for _ in range(1):
        m = mask
        m = m & np.roll(m, 1, 0) & np.roll(m, -1, 0) & np.roll(m, 1, 1) & np.roll(m, -1, 1)
        mask = m
    width = mask.shape[1]

    boxes = []
    seg_start: Optional[int] = None
    row_hits = mask.sum(axis=1)
    for y in range(mask.shape[0] + 1):
        hit = y < mask.shape[0] and row_hits[y] >= ROW_MIN
        if hit and seg_start is None:
            seg_start = y
        elif not hit and seg_start is not None:
            seg = mask[seg_start:y]
            cols = seg.sum(axis=0)
            xs = np.where(cols > 1)[0]
            if len(xs) > 8:
                bx0, bx1 = int(xs[0]), int(xs[-1])
                if (bx1 - bx0) >= MIN_W and (y - seg_start) >= MIN_H:
                    center = (bx0 + bx1) / 2
                    direction = "out" if center > width * 0.52 else "in"
                    boxes.append({"x0": x0 + bx0, "y0": y0 + seg_start,
                                  "x1": x0 + bx1, "y1": y0 + y,
                                  "direction": direction})
            seg_start = None
    boxes.sort(key=lambda box: box["y0"])
    return boxes


def masked_customer_name(text: str) -> str:
    """拼多多客户端对客户名做星号掩码（如 '超***'）。OCR 读不出星号，
    但首字能读——识别到"单字 + 掩码符号残片"时统一还原为 姓*** 形态。"""
    import re

    t = (text or "").strip()
    m = re.match(r"^([\u4e00-\u9fff])\s*[\*＊·．.…\s]*(?:[\u4e00-\u9fff]{0,1})?$", t)
    if m:
        return m.group(1) + "***"
    return t


# 框内文本过滤（拼多多的元数据小条/横幅也画在浅底上，颜色分不干净，这里再滤一道）
import re as _re
_DROP_RE = _re.compile(r"^[\d\s:：/]+$")            # 纯时间/数字框
_STRONG_DROP = ("已退出接待", "来自手机", "来自电脑", "目机", "已读", "未读",
                "AIEBS", "客服叮叮", "服务用语", "小额", "打款", "收款", "添加备注", "点此", "严禁")
_WEAK_DROP = ("机器人套餐", "续费", "诱导", "违规", "主账号")


def _box_text_is_noise(text: str) -> bool:
    t = text.strip()
    if not t or _DROP_RE.match(t):
        return True
    if any(k in t for k in _STRONG_DROP):
        return True            # 强特征（元数据/AIEBS/提示条）——多长都丢
    if any(k in t for k in _WEAK_DROP) and len(t) <= 12:
        return True
    return False


def ocr_bubbles(img_path: str, boxes: list[dict], ocr_image, normalize_text,
                extra_zoom: int = 2) -> list[dict]:
    """对每个气泡框裁剪放大后单独 OCR。返回 [{direction, text, y}]。"""
    from PIL import Image

    img = Image.open(img_path)
    messages = []
    for i, box in enumerate(boxes):
        pad = 6
        crop = img.crop((max(0, box["x0"] - pad), max(0, box["y0"] - pad),
                         min(img.width, box["x1"] + pad), min(img.height, box["y1"] + pad)))
        crop = crop.resize((crop.width * extra_zoom, crop.height * extra_zoom), Image.LANCZOS)
        p = os.path.join(os.path.dirname(img_path), f"pdd_bubble_{i}.png")
        crop.save(p)
        try:
            lines = ocr_image(p)
        except Exception:  # noqa: BLE001
            continue
        text = "\n".join(normalize_text(ln["text"]).strip()
                         for ln in lines if ln["text"].strip())
        text = text.strip()
        if not text or _box_text_is_noise(text):
            continue
        messages.append({"direction": box["direction"], "text": text,
                         "timeText": "", "y": box["y0"]})
    return messages
