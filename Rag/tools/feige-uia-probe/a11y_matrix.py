#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UIA 可读性矩阵 + 遮挡分析（只读）。

对抖店/飞鸽进程的每个 Chromium 顶层窗口：
  1. 附加 UIA，统计元素树节点数与文本节点数，判断是否出现 DocumentControl；
  2. 结合 EnumWindows 的 z 序，计算该窗口被上层窗口遮挡的比例。

用途：判定"主窗口 UIA 树为空"是否由窗口被遮挡（Chromium 对遮挡窗口停止构建
无障碍树）引起，而不是探针本身的问题。

只读：仅查询类 API 与 UIA 读取，不做任何输入、注入或状态修改。
"""

from __future__ import annotations

import ctypes
import json
import os
from ctypes import wintypes
from datetime import datetime, timezone

import uiautomation as auto

from win_enum import (  # noqa: E402  (同目录模块)
    EnumWindowsProc,
    get_class_name,
    get_pid,
    get_rect,
    get_window_text,
    user32,
)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")
PROCESS_HINTS = ("doudian", "feige", "douyin")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def inter_area(a: dict, b: dict) -> int:
    if not a or not b:
        return 0
    x1 = max(a["left"], b["left"])
    y1 = max(a["top"], b["top"])
    x2 = min(a["left"] + a["width"], b["left"] + b["width"])
    y2 = min(a["top"] + a["height"], b["top"] + b["height"])
    if x2 <= x1 or y2 <= y1:
        return 0
    return (x2 - x1) * (y2 - y1)


def walk_counts(control, max_nodes: int = 6000, max_depth: int = 30) -> dict:
    """统计 UIA 子树规模与文本节点数（只读遍历）。"""
    stats = {"nodes": 0, "text_nodes": 0, "document_controls": 0,
             "text_controls": 0, "max_depth": 0, "sample_text_len": 0}

    def visit(node, depth: int) -> None:
        if stats["nodes"] >= max_nodes or depth > max_depth:
            return
        stats["nodes"] += 1
        stats["max_depth"] = max(stats["max_depth"], depth)
        ctype = ""
        try:
            ctype = node.ControlTypeName or ""
        except Exception:
            pass
        if ctype == "DocumentControl":
            stats["document_controls"] += 1
        if ctype in ("TextControl", "EditControl"):
            stats["text_controls"] += 1
        try:
            name = (node.Name or "").strip()
        except Exception:
            name = ""
        if name:
            stats["text_nodes"] += 1
            stats["sample_text_len"] = max(stats["sample_text_len"], len(name))
        try:
            children = node.GetChildren()
        except Exception:
            children = []
        for child in children or []:
            visit(child, depth + 1)

    # 从窗口自身开始统计（不含窗口标题本身）
    try:
        roots = control.GetChildren() or []
    except Exception:
        roots = []
    for root in roots:
        visit(root, 1)
    return stats


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    auto.SetGlobalSearchTimeout(3)

    # z 序：EnumWindows 自顶向下
    z_order: list[int] = []

    def collect(hwnd, _lparam):
        z_order.append(int(hwnd))
        return True

    user32.EnumWindows(EnumWindowsProc(collect), 0)

    fg = int(user32.GetForegroundWindow())

    entries: list[dict] = []
    for idx, hwnd in enumerate(z_order):
        cls = get_class_name(hwnd)
        if cls != "Chrome_WidgetWin_1":
            continue
        pid = get_pid(hwnd)
        entries.append({
            "hwnd": hwnd,
            "pid": pid,
            "class": cls,
            "title": get_window_text(hwnd),
            "visible": bool(user32.IsWindowVisible(wintypes.HWND(hwnd))),
            "minimized": bool(user32.IsIconic(wintypes.HWND(hwnd))),
            "rect": get_rect(hwnd),
            "z_index": idx,
        })

    # 只保留抖店相关进程
    related = [e for e in entries if _matches(e["pid"])]

    results: list[dict] = []
    for entry in related:
        rect = entry["rect"]
        area = (rect["width"] * rect["height"]) if rect else 0

        # 上层遮挡：z_index 更小（更靠上）且可见、未最小化的窗口覆盖了多少面积
        covering = []
        covered_area = 0
        if rect and area > 0 and entry["visible"]:
            for other in entries:
                if other["hwnd"] == entry["hwnd"]:
                    continue
                if other["z_index"] >= entry["z_index"]:
                    continue
                if not other["visible"] or other["minimized"]:
                    continue
                if not other["rect"]:
                    continue
                overlap = inter_area(other["rect"], rect)
                if overlap <= 0:
                    continue
                covered_area += overlap
                covering.append({
                    "hwnd": other["hwnd"],
                    "title_len": len(other["title"]),
                    "class": other["class"],
                    "overlap_area": overlap,
                })

        coverage = min(1.0, covered_area / area) if area else 0.0

        control = None
        uia = {"nodes": 0, "text_nodes": 0, "document_controls": 0,
               "text_controls": 0, "max_depth": 0, "sample_text_len": 0}
        try:
            control = auto.ControlFromHandle(entry["hwnd"])
            if control is not None:
                uia = walk_counts(control)
        except Exception as exc:  # noqa: BLE001
            uia["error"] = str(exc)[:200]

        results.append({
            "hwnd": entry["hwnd"],
            "pid": entry["pid"],
            "title_len": len(entry["title"]),
            "title_masked": (entry["title"][:1] + "*" * max(0, len(entry["title"]) - 1)) if entry["title"] else "",
            "visible": entry["visible"],
            "minimized": entry["minimized"],
            "rect": rect,
            "is_foreground": entry["hwnd"] == fg,
            "occlusion_coverage": round(coverage, 3),
            "fully_occluded": coverage >= 0.99,
            "covering_windows": covering[:6],
            "uia": uia,
            "uia_readable": uia["text_nodes"] > 0 or uia["document_controls"] > 0,
        })

    # 按 UIA 可读性、遮挡率输出
    results.sort(key=lambda r: (not r["uia_readable"], r["occlusion_coverage"]))

    payload = {
        "generated_at": now_iso(),
        "foreground_hwnd": fg,
        "z_order_total": len(z_order),
        "chromium_windows": len(entries),
        "doudian_windows": len(results),
        "results": results,
    }
    out = os.path.join(OUT_DIR, "a11y_matrix.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    print(f"前台窗口 hwnd={fg}")
    print(f"Chromium 顶层窗口 {len(entries)} 个，其中抖店相关 {len(results)} 个")
    print()
    print(f"{'hwnd':>10} {'可见':<4} {'前台':<4} {'遮挡率':<8} {'UIA节点':<8} "
          f"{'文本节点':<8} {'Doc':<4} {'UIA可读':<8} 标题")
    print("-" * 88)
    for r in results:
        print(f"{r['hwnd']:>10} {int(r['visible']):<4} {int(r['is_foreground']):<4} "
              f"{r['occlusion_coverage']:<8} {r['uia']['nodes']:<8} "
              f"{r['uia']['text_nodes']:<8} {r['uia']['document_controls']:<4} "
              f"{str(r['uia_readable']):<8} {r['title_masked']}")
    print()
    print("遮挡明细（完全遮挡的窗口）：")
    for r in results:
        if r["fully_occluded"] and r["covering_windows"]:
            print(f"  hwnd={r['hwnd']} 被 {len(r['covering_windows'])} 个窗口完全覆盖，"
                  f"其中面积最大的：")
            for c in sorted(r["covering_windows"], key=lambda x: -x["overlap_area"])[:3]:
                print(f"      hwnd={c['hwnd']} cls={c['class']} "
                      f"overlap={c['overlap_area']} title_len={c['title_len']}")
    print()
    print(f"-> {out}")
    return 0


def _matches(pid: int) -> bool:
    from win_enum import process_name
    name = process_name(pid).lower()
    return any(hint in name for hint in PROCESS_HINTS)


if __name__ == "__main__":
    raise SystemExit(main())
