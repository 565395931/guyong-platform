#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""拼多多工作台 UIA 可行性探针（只读）。

结论（2026-10-13 实测）：**当前版本的拼多多工作台不暴露 UI Automation 无障碍树**。
本脚本用于周期复检：客户端升级后重跑一次，看渲染宿主是否开始返回文本节点。

背景与完整证据见 `REPORT-pinduoduo-uia.md`。检测方式沿用飞鸽/千帆的流程：
枚举窗口 → 附加主窗口与全部 Chrome_RenderWidgetHostHWND 渲染宿主 → dump 元素树。

只读：仅 Win32 查询 + UIA 读取，不点击、不输入、不注入进程、不改窗口状态。

用法
----
  python probe.py                 # 检测 + 打印结论
  python probe.py --warmup 30     # 附加后先预热观察 N 秒（Chromium 无障碍树懒构建）
"""

from __future__ import annotations

import argparse
import ctypes
import os
import sys
import time
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
# 复用千帆探针的 Win32/UIA 基础函数（窗口枚举、dump、文本收集）
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "qianfan-uia-probe")))

import uiautomation as auto  # noqa: E402
from qianfan_capture import (  # noqa: E402
    collect_texts, dump_tree, enum_child_hwnds, enum_top_level, get_class_name,
    get_pid, get_rect, get_window_text, process_name,
)

user32 = ctypes.WinDLL("user32", use_last_error=True)

PROCESS_HINTS = ("PddWorkbench.exe", "pddwebworkbench.exe", "PDDWBGd.exe")
MAIN_WINDOW_CLASS_PREFIX = "g_wszPDDWindowClass"


def pdd_windows() -> list[dict]:
    pid_cache: dict = {}
    out = []
    for hwnd in enum_top_level():
        pid = get_pid(hwnd)
        if pid not in pid_cache:
            pid_cache[pid] = process_name(pid)
        proc = pid_cache[pid]
        if not any(h.lower() in proc.lower() for h in PROCESS_HINTS):
            continue
        out.append({
            "hwnd": hwnd,
            "pid": pid,
            "process": proc,
            "class": get_class_name(hwnd),
            "title": get_window_text(hwnd),
            "visible": bool(user32.IsWindowVisible(hwnd)),
            "rect": get_rect(hwnd),
            "render_hosts": [c for c in enum_child_hwnds(hwnd)
                             if get_class_name(c) == "Chrome_RenderWidgetHostHWND"],
        })
    return out


def text_count(hwnd: int) -> int:
    try:
        ctrl = auto.ControlFromHandle(hwnd)
        if ctrl is None:
            return -1
        return len(collect_texts(dump_tree(ctrl, max_nodes=30000)))
    except Exception:  # noqa: BLE001
        return -1


def main() -> int:
    parser = argparse.ArgumentParser(description="拼多多工作台 UIA 可行性探针（只读）")
    parser.add_argument("--warmup", type=float, default=0.0,
                        help="附加后先轮询预热观察的秒数（默认 0，直接测一轮）")
    args = parser.parse_args()
    sys.setrecursionlimit(20000)
    auto.SetGlobalSearchTimeout(2.0)

    windows = pdd_windows()
    if not windows:
        print("未找到拼多多工作台进程（PddWorkbench.exe 等未运行）")
        return 3

    print(f"拼多多相关顶层窗口: {len(windows)}")
    main_window = None
    for w in windows:
        if w["class"].startswith(MAIN_WINDOW_CLASS_PREFIX) and w["visible"]:
            main_window = w
        r = w["rect"] or {}
        mark = " ← 主窗口" if w is main_window else ""
        print(f"  hwnd={w['hwnd']:>9} [{'V' if w['visible'] else ' '}] "
              f"{w['class'][:44]:<46} {w['title'][:18]!r} render_hosts={w['render_hosts']}{mark}")

    if main_window is None:
        print("未找到可见主窗口（g_wszPDDWindowClass*）")
        return 3

    targets = [("主窗口", main_window["hwnd"])]
    for h in main_window["render_hosts"]:
        targets.append(("渲染宿主", h))

    deadline = time.monotonic() + args.warmup
    last = {}
    round_no = 0
    while True:
        round_no += 1
        counts = {label_hwnd: text_count(label_hwnd[1]) for label_hwnd in targets}
        if counts != last:
            print(f"第{round_no}轮: " + "  ".join(
                f"{label}{hwnd}={count}" for (label, hwnd), count in counts.items()))
            last = dict(counts)
        if time.monotonic() >= deadline:
            break
        time.sleep(3)

    host_counts = [c for (label, _), c in counts.items() if label == "渲染宿主"]
    readable = any(c > 5 for c in host_counts)
    print()
    if readable:
        print("✅ 渲染宿主已返回文本节点——UIA 可读，可沿用千帆流程做捕捉/自动化")
        return 0
    print("❌ 渲染宿主无文本节点——当前版本 UIA 不可读（与 2026-10-13 结论一致）")
    print("   备选路线见 REPORT-pinduoduo-uia.md：网页版 mms.pinduoduo.com 自动化 / 截图 OCR")
    return 4


if __name__ == "__main__":
    raise SystemExit(main())
