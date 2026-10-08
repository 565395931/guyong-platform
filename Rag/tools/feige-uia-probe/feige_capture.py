#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按 UIA 给的矩形截屏（头像 / 表情图）。

为什么必须截图
--------------
飞鸽界面的头像节点只有一个 ``name='头像'``，**没有 URL、没有本地路径、没有
FullDescription**；表情/图片消息在元素树里也只有占位文字（如"表情"）。
所以图像内容只能按 UIA 提供的 rect 从屏幕上裁剪。

已知限制
--------
**滚出视野的节点 rect 是 0x0，截不到。** 只有当前可见的头像/表情才能截，
历史的需要先滚动到可见位置。这不是实现缺陷，是屏幕抓取的固有限制。
"""

from __future__ import annotations

import ctypes
import io
import sys
from typing import Optional


def _ensure_dpi_aware() -> None:
    """UIA 返回的 rect 是物理像素，而截图 API 默认按逻辑像素。

    不做 DPI 感知的话，在缩放不是 100% 的机器上截出来的位置会整体偏移。
    """
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


MINIMIZED_SENTINEL = -30000


def window_screen_rect(hwnd: int) -> Optional[dict]:
    """用 Win32 取窗口的绝对屏幕矩形。最小化时返回 None。"""
    import ctypes
    from ctypes import wintypes

    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    user32 = ctypes.windll.user32
    rect = RECT()
    if not user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect)):
        return None
    # 最小化窗口的位置是哨兵值 -32000，不是真实屏幕位置
    if rect.left <= MINIMIZED_SENTINEL or rect.top <= MINIMIZED_SENTINEL:
        return None
    if not user32.IsWindowVisible(wintypes.HWND(hwnd)):
        return None
    if user32.IsIconic(wintypes.HWND(hwnd)):
        return None
    return {
        "left": rect.left,
        "top": rect.top,
        "width": rect.right - rect.left,
        "height": rect.bottom - rect.top,
    }


def is_capturable(hwnd: int) -> bool:
    """窗口是否处于"可以按绝对屏幕坐标截图"的状态。

    ⚠️ 坐标系陷阱（实测踩过）
    ------------------------
    UIA 的 BoundingRectangle 在窗口**可见**时是**绝对屏幕坐标**，但窗口**最小化**时
    Chromium 返回的是**相对窗口**的坐标（值小、落在窗口尺寸范围内）。
    若不判断就拿去 ImageGrab.grab(bbox=...)，会截到屏幕上那个位置的无关内容
    （实测截到了灰色渐变，而不是表情）。

    所以：窗口不可见/最小化时**必须拒绝截图**。
    """
    return window_screen_rect(hwnd) is not None


def capture_rect(rect: Optional[dict]) -> Optional[bytes]:
    """裁剪 rect 区域并返回 PNG 字节；rect 无效（含 0x0）时返回 None。"""
    if not rect:
        return None
    width = int(rect.get("width") or 0)
    height = int(rect.get("height") or 0)
    left = int(rect.get("left") or 0)
    top = int(rect.get("top") or 0)
    # 未布局的节点 rect 是 @0,0 0x0，这种直接放弃
    if width <= 0 or height <= 0:
        return None
    # 尺寸离谱的多半是读到了脏数据，避免截整屏
    if width > 2000 or height > 2000:
        return None

    _ensure_dpi_aware()
    try:
        from PIL import ImageGrab

        image = ImageGrab.grab(bbox=(left, top, left + width, top + height))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=True)
        return buffer.getvalue()
    except Exception as exc:  # noqa: BLE001
        print(f"[capture] 截屏失败 rect={rect}: {type(exc).__name__}: {exc}",
              file=sys.stderr)
        return None


def image_signature(png: bytes) -> str:
    """图像内容摘要，用于判断头像是否变化（避免每次都重复上传同一张）。"""
    import hashlib

    return hashlib.sha256(png).hexdigest()[:16]


if __name__ == "__main__":
    import argparse
    import base64

    parser = argparse.ArgumentParser(description="按矩形截屏（调试用）")
    parser.add_argument("--rect", required=True, help="left,top,width,height")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    l, t, w, h = (int(x) for x in args.rect.split(","))
    png = capture_rect({"left": l, "top": t, "width": w, "height": h})
    if png is None:
        print("截屏失败（rect 无效或超出范围）")
        raise SystemExit(1)
    if args.out:
        with open(args.out, "wb") as fh:
            fh.write(png)
        print(f"已保存 {args.out}（{len(png)} 字节，签名 {image_signature(png)}）")
    else:
        print(base64.b64encode(png).decode("ascii"))
