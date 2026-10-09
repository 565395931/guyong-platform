#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Win32 只读窗口枚举：定位飞鸽/抖店相关进程的全部顶层窗口与子窗口。

只使用 Win32 查询类 API（EnumWindows / GetClassName / GetWindowText /
GetWindowRect / IsWindowVisible / IsIconic / QueryFullProcessImageName）。
不发送键鼠输入，不读写进程内存，不注入，不修改窗口状态。

输出：out/windows.json，并在终端打印摘要。
"""

from __future__ import annotations

import ctypes
import json
import os
import sys
from ctypes import wintypes
from datetime import datetime, timezone

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

GWL_STYLE = -16
GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")

PROCESS_HINTS = ("doudian", "feige", "douyin", "promecef", "msedgewebview2")


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def get_window_text(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(1024)
    user32.GetWindowTextW(wintypes.HWND(hwnd), buf, 1024)
    return buf.value


def get_class_name(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(512)
    user32.GetClassNameW(wintypes.HWND(hwnd), buf, 512)
    return buf.value


def get_pid(hwnd: int) -> int:
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(pid))
    return int(pid.value)


def get_rect(hwnd: int):
    rect = RECT()
    if not user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect)):
        return None
    return {
        "left": rect.left,
        "top": rect.top,
        "width": rect.right - rect.left,
        "height": rect.bottom - rect.top,
    }


def process_name(pid: int) -> str:
    """只查询进程映像路径，不读取进程内存。"""
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return "?"
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value)
        return "?"
    finally:
        kernel32.CloseHandle(handle)


def window_info(hwnd: int, pid_cache: dict) -> dict:
    pid = get_pid(hwnd)
    if pid not in pid_cache:
        pid_cache[pid] = process_name(pid)
    style = user32.GetWindowLongW(wintypes.HWND(hwnd), GWL_STYLE)
    exstyle = user32.GetWindowLongW(wintypes.HWND(hwnd), GWL_EXSTYLE)
    owner = user32.GetWindow(wintypes.HWND(hwnd), 4)  # GW_OWNER
    parent = user32.GetParent(wintypes.HWND(hwnd))
    return {
        "hwnd": int(hwnd),
        "pid": pid,
        "process": pid_cache[pid],
        "class": get_class_name(hwnd),
        "title": get_window_text(hwnd),
        "visible": bool(user32.IsWindowVisible(wintypes.HWND(hwnd))),
        "minimized": bool(user32.IsIconic(wintypes.HWND(hwnd))),
        "rect": get_rect(hwnd),
        "owner": int(owner) if owner else 0,
        "parent": int(parent) if parent else 0,
        "style": hex(style & 0xFFFFFFFF),
        "exstyle": hex(exstyle & 0xFFFFFFFF),
        "toolwindow": bool(exstyle & WS_EX_TOOLWINDOW),
    }


def enum_children(hwnd: int) -> list:
    out: list = []

    def cb(child, _lparam):
        out.append(int(child))
        return True

    user32.EnumChildWindows(wintypes.HWND(hwnd), EnumWindowsProc(cb), 0)
    return out


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)

    top_level: list[int] = []

    def collect(hwnd, _lparam):
        top_level.append(int(hwnd))
        return True

    user32.EnumWindows(EnumWindowsProc(collect), 0)

    pid_cache: dict = {}
    all_windows = [window_info(h, pid_cache) for h in top_level]

    # 抖店/飞鸽相关进程的全部窗口
    related = [
        w for w in all_windows
        if any(hint in w["process"].lower() for hint in PROCESS_HINTS)
    ]

    # 这些窗口的子窗口（Chromium 的 render host 是子 HWND）
    for parent in related:
        children = enum_children(parent["hwnd"])
        parent["child_hwnds"] = [
            {
                "hwnd": c,
                "class": get_class_name(c),
                "visible": bool(user32.IsWindowVisible(wintypes.HWND(c))),
                "rect": get_rect(c),
            }
            for c in children
        ]
        # 把与父窗口同进程且非顶层的新窗口补进 related（保留完整视图）
        known = {w["hwnd"] for w in related}
        for c in children:
            if c in known or c in {int(h) for h in top_level}:
                continue
            info = window_info(c, pid_cache)
            info["child_hwnds"] = []
            related.append(info)
            known.add(c)

    # 所有 Chrome_WidgetWin_1（Electron/Chromium）窗口，便于发现其它宿主
    chromium_all = [w for w in all_windows if w["class"] == "Chrome_WidgetWin_1"]

    payload = {
        "generated_at": now_iso(),
        "total_top_level_windows": len(all_windows),
        "process_hints": list(PROCESS_HINTS),
        "related_window_count": len(related),
        "related_windows": related,
        "chromium_window_count": len(chromium_all),
        "chromium_windows": [
            {
                "hwnd": w["hwnd"], "pid": w["pid"], "process": w["process"],
                "title_len": len(w["title"]), "visible": w["visible"],
                "minimized": w["minimized"], "rect": w["rect"],
            }
            for w in chromium_all
        ],
    }

    out = os.path.join(OUT_DIR, "windows.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    print(f"顶层窗口总数: {len(all_windows)}")
    print(f"Chromium(Chrome_WidgetWin_1) 窗口: {len(chromium_all)}")
    print(f"抖店/飞鸽相关窗口: {len(related)}")
    print()
    print("=== 抖店/飞鸽相关窗口（含子窗口）===")
    for w in related:
        title = w["title"]
        shown = (title[:24] + "…") if len(title) > 24 else title
        size = f"{w['rect']['width']}x{w['rect']['height']}@{w['rect']['left']},{w['rect']['top']}" if w["rect"] else "?"
        print(f"hwnd={w['hwnd']:>10} pid={w['pid']:<6} {w['process'][:22]:<22} "
              f"cls={w['class'][:28]:<28} vis={int(w['visible'])} min={int(w['minimized'])} "
              f"{size:<22} kids={len(w['child_hwnds']):<3} title={shown!r}")
    print()
    print("=== 全部 Chromium 窗口（按面积排序）===")
    def area(w):
        r = w["rect"]
        return (r["width"] * r["height"]) if r else 0
    for w in sorted(chromium_all, key=area, reverse=True)[:20]:
        r = w["rect"] or {}
        print(f"hwnd={w['hwnd']:>10} pid={w['pid']:<6} {w['process'][:22]:<22} "
              f"vis={int(w['visible'])} min={int(w['minimized'])} "
              f"{r.get('width')}x{r.get('height')}@{r.get('left')},{r.get('top')} "
              f"title_len={len(w['title'])}")
    print()
    print(f"-> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
