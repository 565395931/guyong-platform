#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""深度只读探测：从渲染宿主 / D3D 表面直接取树，并检查 MSAA(LegacyIAccessible) 通路。

背景
----
主窗口顶层只有一条空的 PaneControl 链，但它的 Chrome_RenderWidgetHostHWND 子窗口
可见性是 vis=0（Direct Composition 路径），而可读的悬浮小组件/浮窗的渲染宿主是
vis=1。本脚本绕过顶层窗口，直接从渲染宿主与 D3D 窗口附加 UIA，并检查
LegacyIAccessiblePattern（Chromium 的 MSAA 通路）是否暴露内容。

只读：仅 UIA 读取与 Win32 查询，不点击、不输入、不发送、不改窗口状态。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
from ctypes import wintypes
from datetime import datetime, timezone

import uiautomation as auto

from win_enum import get_class_name, get_rect, get_window_text, user32

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")

PATTERN_PROBES = (
    "IsTextPatternAvailable",
    "IsValuePatternAvailable",
    "IsLegacyIAccessiblePatternAvailable",
    "IsInvokePatternAvailable",
    "IsScrollPatternAvailable",
)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def enum_child_hwnds(parent: int) -> list[int]:
    out: list[int] = []

    def cb(hwnd, _lparam):
        out.append(int(hwnd))
        return True

    from win_enum import EnumWindowsProc
    user32.EnumChildWindows(wintypes.HWND(parent), EnumWindowsProc(cb), 0)
    return out


def describe(hwnd: int, label: str, max_nodes: int = 4000) -> dict:
    """从指定 HWND 附加 UIA 并遍历，统计节点、文本与 Pattern 可用性。"""
    result: dict = {
        "label": label,
        "hwnd": hwnd,
        "class": get_class_name(hwnd),
        "title": get_window_text(hwnd),
        "rect": get_rect(hwnd),
        "visible": bool(user32.IsWindowVisible(wintypes.HWND(hwnd))),
        "attached": False,
        "nodes": 0,
        "text_nodes": 0,
        "texts": [],
        "pattern_hits": {},
        "legacy_details": [],
        "error": None,
    }

    control = None
    try:
        control = auto.ControlFromHandle(hwnd)
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"ControlFromHandle 失败: {exc}"
        return result
    if control is None:
        result["error"] = "ControlFromHandle 返回 None"
        return result
    result["attached"] = True

    def visit(node, depth: int) -> None:
        if result["nodes"] >= max_nodes or depth > 40:
            return
        result["nodes"] += 1

        for probe in PATTERN_PROBES:
            try:
                if getattr(node, probe)():
                    key = probe.replace("Is", "").replace("Available", "")
                    result["pattern_hits"][key] = result["pattern_hits"].get(key, 0) + 1
            except Exception:
                pass

        name = ""
        try:
            name = (node.Name or "").strip()
        except Exception:
            pass
        if name:
            result["text_nodes"] += 1
            if len(result["texts"]) < 60:
                result["texts"].append({
                    "depth": depth,
                    "len": len(name),
                    "preview_sha": __import__("hashlib").sha256(
                        name.encode("utf-8", "replace")).hexdigest()[:12],
                })

        # LegacyIAccessible 明细：能拿到角色/名称就说明 MSAA 通路是活的
        try:
            if node.IsLegacyIAccessiblePatternAvailable():
                pat = node.GetLegacyIAccessiblePattern()
                legacy_name = (pat.Name or "").strip()
                if legacy_name or pat.Role:
                    result["legacy_details"].append({
                        "depth": depth,
                        "role": int(pat.Role) if pat.Role is not None else None,
                        "name_len": len(legacy_name),
                        "name_sha": __import__("hashlib").sha256(
                            legacy_name.encode("utf-8", "replace")).hexdigest()[:12] if legacy_name else "",
                    })
        except Exception:
            pass

        try:
            children = node.GetChildren()
        except Exception:
            children = []
        for child in children or []:
            visit(child, depth + 1)

    try:
        visit(control, 0)
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"遍历中断: {exc}"
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--window", type=int, default=0, help="抖店主窗口索引（见 a11y_matrix）")
    parser.add_argument("--out", default=os.path.join(OUT_DIR, "deep_probe.json"))
    args = parser.parse_args()

    auto.SetGlobalSearchTimeout(1)
    os.makedirs(OUT_DIR, exist_ok=True)

    # 定位主窗口：标题以 [商家] 开头的 Chrome_WidgetWin_1
    main_hwnd = None
    candidates: list[int] = []

    def collect(hwnd, _lparam):
        candidates.append(int(hwnd))
        return True

    from win_enum import EnumWindowsProc
    user32.EnumWindows(EnumWindowsProc(collect), 0)

    for hwnd in candidates:
        if get_class_name(hwnd) != "Chrome_WidgetWin_1":
            continue
        title = get_window_text(hwnd)
        if title.startswith("[商家]"):
            main_hwnd = hwnd
            break

    if main_hwnd is None:
        print("未找到主窗口（标题以 [商家] 开头）")
        return 1

    print(f"主窗口 hwnd={main_hwnd} title_len={len(get_window_text(main_hwnd))}")

    targets: list[tuple[int, str]] = [(main_hwnd, "主窗口(顶层)")]
    for child in enum_child_hwnds(main_hwnd):
        cls = get_class_name(child)
        if cls in ("Chrome_RenderWidgetHostHWND", "Intermediate D3D Window"):
            targets.append((child, f"子窗口 {cls}"))

    results = [describe(hwnd, label) for hwnd, label in targets]

    payload = {
        "generated_at": now_iso(),
        "main_window_hwnd": main_hwnd,
        "targets": results,
        "conclusion_hint": (
            "若各级节点 text_nodes 均为 0、LegacyIAccessible 也无明细，"
            "则主窗口内容在 UIA 与 MSAA 两条通路下都不可达。"
        ),
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    print()
    for r in results:
        print(f"--- {r['label']} hwnd={r['hwnd']} cls={r['class']} vis={int(r['visible'])}")
        print(f"    attached={r['attached']} nodes={r['nodes']} "
              f"text_nodes={r['text_nodes']} error={r['error']}")
        print(f"    patterns={r['pattern_hits']}")
        print(f"    legacy_details={len(r['legacy_details'])}")
    print(f"\n-> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
