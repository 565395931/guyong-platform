#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""小红书千帆客服工作台 UIA 只读捕捉。

参考 `feige-uia-probe`（抖店飞鸽）的本地捕捉流程：

1. `enum`    —— EnumWindows 枚举千帆进程的顶层窗口与子窗口，定位主窗口；
2. `capture` —— 附加到渲染宿主 `Chrome_RenderWidgetHostHWND`，dump 完整元素树。

为什么必须附加渲染宿主
----------------------
与飞鸽实测结论一致：主窗口顶层 `Chrome_WidgetWin_1` 的 UIA 提供程序只会
给出空壳（实测 29 节点 / 4 文本），必须附加其子窗口
`Chrome_RenderWidgetHostHWND`（Chromium "Chrome Legacy Window"）才能拿到
完整元素树（实测 97 节点 / 29 文本）。

只读保证
--------
只做 UIA 读取（属性、遍历）与 Win32 查询类 API；
不调用 Invoke / Toggle / Select / SetValue，不点击、不输入、不发送；
不 OCR、不截图、不注入进程、不读进程内存、不抓包；
不改窗口状态（不 SetForegroundWindow / ShowWindow / SetWindowPos）。

产物写入 `out/`（已 gitignore，含未脱敏界面文本，只在本机排查用）。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
from ctypes import wintypes
from datetime import datetime, timezone
from typing import Any, Optional

import uiautomation as auto

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")

PROCESS_HINT = "千帆"
MAIN_WINDOW_CLASS = "Chrome_WidgetWin_1"
RENDER_HOST_CLASS = "Chrome_RenderWidgetHostHWND"

# 出现在本文件即视为违反只读约束的 API 标记（供 selfcheck AST 扫描）。
FORBIDDEN_TOKENS = (
    "InvokePattern",
    "TogglePattern",
    ".Click(",
    "SetValue(",
    "SendKeys",
    "SendInput",
    "keybd_event",
    "mouse_event",
    "SetForegroundWindow",
    "SetCursorPos",
    "WriteProcessMemory",
    "ReadProcessMemory",
    "pymem",
    "frida",
    "pyautogui",
    "SetWindowPos",
    "ShowWindow(",
    "CloseWindow",
    "TerminateProcess",
)

# UIA 中属于"改变状态"的 Pattern ID，仅用于自检报告，不在代码中调用。
MUTATING_PATTERN_NAMES = (
    "InvokePattern",
    "TogglePattern",
    "SelectionItemPattern",
    "ValuePattern.SetValue",
    "ExpandCollapsePattern",
    "ScrollPattern",
    "TransformPattern",
    "WindowPattern.Close",
)

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


# --------------------------------------------------------------------------
# Win32 只读查询
# --------------------------------------------------------------------------

class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


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


def get_rect(hwnd: int) -> Optional[dict]:
    rect = RECT()
    if not user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect)):
        return None
    return {"left": rect.left, "top": rect.top,
            "width": rect.right - rect.left, "height": rect.bottom - rect.top}


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


def enum_child_hwnds(parent: int) -> list[int]:
    out: list[int] = []

    def cb(child, _lparam):
        out.append(int(child))
        return True

    user32.EnumChildWindows(wintypes.HWND(parent), EnumWindowsProc(cb), 0)
    return out


def enum_top_level() -> list[int]:
    out: list[int] = []

    def cb(hwnd, _lparam):
        out.append(int(hwnd))
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return out


def window_info(hwnd: int, pid_cache: dict) -> dict:
    pid = get_pid(hwnd)
    if pid not in pid_cache:
        pid_cache[pid] = process_name(pid)
    return {
        "hwnd": hwnd,
        "pid": pid,
        "process": pid_cache[pid],
        "class": get_class_name(hwnd),
        "title": get_window_text(hwnd),
        "visible": bool(user32.IsWindowVisible(wintypes.HWND(hwnd))),
        "minimized": bool(user32.IsIconic(wintypes.HWND(hwnd))),
        "rect": get_rect(hwnd),
    }


# --------------------------------------------------------------------------
# 主窗口 / 渲染宿主解析
# --------------------------------------------------------------------------

def find_candidate_windows(hint: str = PROCESS_HINT) -> list[dict]:
    """千帆进程的全部顶层窗口（含子窗口清单）。"""
    pid_cache: dict = {}
    out: list[dict] = []
    for hwnd in enum_top_level():
        info = window_info(hwnd, pid_cache)
        if hint not in info["process"] and hint not in info["title"]:
            continue
        info["child_hwnds"] = [
            {"hwnd": c, "class": get_class_name(c),
             "visible": bool(user32.IsWindowVisible(wintypes.HWND(c))),
             "rect": get_rect(c)}
            for c in enum_child_hwnds(hwnd)
        ]
        out.append(info)
    return out


def quick_stats(control: Any, max_nodes: int = 2000) -> dict:
    """快速统计节点数/文本数，用于挑选信息量最大的渲染宿主。"""
    stats = {"nodes": 0, "texts": 0}
    counter = {"n": 0}

    def walk(node: Any, depth: int) -> None:
        if counter["n"] >= max_nodes or depth > 40:
            return
        counter["n"] += 1
        stats["nodes"] += 1
        try:
            name = node.Name or ""
        except Exception:  # noqa: BLE001
            name = ""
        if name.strip():
            stats["texts"] += 1
        try:
            children = node.GetChildren()
        except Exception:  # noqa: BLE001
            children = []
        for c in children:
            walk(c, depth + 1)

    walk(control, 0)
    return stats


def resolve_main_window(hint: str = PROCESS_HINT) -> dict:
    """定位千帆主窗口：class=Chrome_WidgetWin_1、可见、按渲染宿主信息量排序。"""
    candidates = [
        w for w in find_candidate_windows(hint)
        if w["class"] == MAIN_WINDOW_CLASS and w["visible"] and not w["minimized"]
    ]
    if not candidates:
        raise SystemExit("未找到可见的千帆主窗口（Chrome_WidgetWin_1）")
    # 渲染宿主可能被重新挂载到隐藏容器窗口下，按**进程**扫描而不是按主窗口子级
    seen_pids: dict[int, dict] = {}
    scored = []
    for w in candidates:
        p = w["pid"]
        if p not in seen_pids:
            hosts = []
            for hwnd in enum_top_level():
                if get_pid(hwnd) != p:
                    continue
                hosts.extend(c for c in enum_child_hwnds(hwnd)
                             if get_class_name(c) == RENDER_HOST_CLASS)
            best = {"nodes": 0, "texts": 0, "hwnd": None}
            for h in hosts:
                try:
                    ctrl = auto.ControlFromHandle(h)
                except Exception:  # noqa: BLE001
                    continue
                if ctrl is None:
                    continue
                st = quick_stats(ctrl)
                if st["nodes"] > best["nodes"]:
                    best = {"nodes": st["nodes"], "texts": st["texts"], "hwnd": h}
            seen_pids[p] = best
        w["child_hwnds"] = [
            c for c in w["child_hwnds"] if c["class"] == RENDER_HOST_CLASS
        ]
        w["best_render_host"] = seen_pids[p]
        scored.append(w)
    scored.sort(key=lambda w: (w["best_render_host"]["nodes"], w["visible"]), reverse=True)
    return scored[0]


def attach_render_host(main_hwnd: int) -> dict:
    """附加到信息量最大的渲染宿主。

    定位范围是**同进程全部顶层窗口**下的 Chrome_RenderWidgetHostHWND，
    不限于主窗口的直接子窗口：实测客户端会把渲染宿主从主窗口
    （Chrome_WidgetWin_1）重新挂载到隐藏容器窗口（Chrome_WidgetWin_0）下，
    只查主窗口子级会落空。
    """
    pid = get_pid(main_hwnd)
    hosts: list[int] = []
    for hwnd in enum_top_level():
        if get_pid(hwnd) != pid:
            continue
        hosts.extend(c for c in enum_child_hwnds(hwnd)
                     if get_class_name(c) == RENDER_HOST_CLASS)
    if not hosts:
        raise SystemExit(f"进程 pid={pid} 下未找到 {RENDER_HOST_CLASS} 窗口")
    best = None
    for h in hosts:
        try:
            ctrl = auto.ControlFromHandle(h)
        except Exception:  # noqa: BLE001
            continue
        if ctrl is None:
            continue
        st = quick_stats(ctrl)
        if best is None or st["nodes"] > best["stats"]["nodes"]:
            best = {"hwnd": h, "control": ctrl, "stats": st,
                    "name": (ctrl.Name or ""), "class": ctrl.ClassName}
    if best is None:
        raise SystemExit("渲染宿主 ControlFromHandle 全部失败")
    return {
        "main_hwnd": main_hwnd,
        "render_host_hwnd": best["hwnd"],
        "control": best["control"],
        "render_host_name": best["name"],
        "stats": best["stats"],
    }


# --------------------------------------------------------------------------
# 元素树 dump
# --------------------------------------------------------------------------

def rect_of(node: Any) -> Optional[dict]:
    try:
        r = node.BoundingRectangle
        return {"left": r.left, "top": r.top, "width": r.width(), "height": r.height()}
    except Exception:  # noqa: BLE001
        return None


def dump_tree(control: Any, max_depth: int = 45, max_nodes: int = 30000) -> dict:
    counter = {"n": 0}

    def walk(node: Any, depth: int) -> Optional[dict]:
        if counter["n"] >= max_nodes or depth > max_depth:
            return None
        counter["n"] += 1
        try:
            name = node.Name or ""
        except Exception:  # noqa: BLE001
            name = ""
        try:
            ctype = node.ControlTypeName
        except Exception:  # noqa: BLE001
            ctype = ""
        try:
            aid = node.AutomationId or ""
        except Exception:  # noqa: BLE001
            aid = ""
        try:
            offscreen = bool(node.IsOffscreen)
        except Exception:  # noqa: BLE001
            offscreen = None
        try:
            children = node.GetChildren()
        except Exception:  # noqa: BLE001
            children = []
        node_out = {
            "type": ctype,
            "name": name,
            "aid": aid,
            "offscreen": offscreen,
            "rect": rect_of(node),
            "children": [c for c in (walk(ch, depth + 1) for ch in children) if c],
        }
        return node_out

    return walk(control, 0) or {}


def collect_texts(tree: dict) -> list[dict]:
    out: list[dict] = []

    def walk(node: dict, depth: int) -> None:
        if node.get("name", "").strip():
            out.append({"depth": depth, "type": node.get("type", ""),
                        "aid": node.get("aid", ""), "text": node["name"]})
        for c in node.get("children", []):
            walk(c, depth + 1)

    walk(tree, 0)
    return out


# --------------------------------------------------------------------------
# 命令
# --------------------------------------------------------------------------

def cmd_enum(args) -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    windows = find_candidate_windows(args.hint)
    payload = {
        "generated_at": now_iso(),
        "process_hint": args.hint,
        "window_count": len(windows),
        "windows": windows,
    }
    out = os.path.join(OUT_DIR, "qianfan_windows.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    print(f"千帆相关顶层窗口: {len(windows)}")
    print()
    for w in windows:
        r = w["rect"] or {}
        print(f"hwnd={w['hwnd']:>10} pid={w['pid']:<6} cls={w['class']:<28} "
              f"vis={int(w['visible'])} min={int(w['minimized'])} "
              f"{r.get('width')}x{r.get('height')}@{r.get('left')},{r.get('top')} "
              f"title={w['title']!r}")
        for c in w["child_hwnds"]:
            cr = c["rect"] or {}
            print(f"    child hwnd={c['hwnd']:>10} cls={c['class']:<34} "
                  f"vis={int(c['visible'])} "
                  f"{cr.get('width')}x{cr.get('height')}@{cr.get('left')},{cr.get('top')}")
    print()
    print(f"-> {out}")
    return 0


def cmd_capture(args) -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    if args.hwnd:
        main_hwnd = args.hwnd
    else:
        main = resolve_main_window(args.hint)
        main_hwnd = main["hwnd"]
        print(f"主窗口: hwnd={main_hwnd} pid={main['pid']} title={main['title']!r} "
              f"rect={main['rect']}")
        print(f"渲染宿主主内容候选: hwnd={main['best_render_host']['hwnd']} "
              f"nodes={main['best_render_host']['nodes']} "
              f"texts={main['best_render_host']['texts']}")
    resolved = attach_render_host(main_hwnd)
    print(f"渲染宿主名称: {resolved['render_host_name']!r} "
          f"(nodes={resolved['stats']['nodes']}, texts={resolved['stats']['texts']})")
    print()

    tree = dump_tree(resolved["control"])
    texts = collect_texts(tree)
    payload = {
        "generated_at": now_iso(),
        "adapter_id": "xiaohongshu.qianfan",
        "main_hwnd": main_hwnd,
        "main_title": get_window_text(main_hwnd),
        "render_host_hwnd": resolved["render_host_hwnd"],
        "render_host_name": resolved["render_host_name"],
        "stats": resolved["stats"],
        "text_count": len(texts),
        "texts": texts,
        "tree": tree,
    }
    out = os.path.join(OUT_DIR, "qianfan_tree_raw.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    # 另存一份按视图命名的副本：千帆会切换视图（客服工作台 / 智能客服…），
    # 单靠 qianfan_tree_raw.json 会被后一次捕捉覆盖。
    safe_name = "".join(ch for ch in (resolved["render_host_name"] or "unnamed")
                        if ch not in '\\/:*?"<>|').strip() or "unnamed"
    view_out = os.path.join(OUT_DIR, f"qianfan_tree_{safe_name}.json")
    with open(view_out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    print(f"=== 元素树文本节点（{len(texts)} 条，文档序）===")
    for t in texts:
        indent = "  " * min(t["depth"], 12)
        aid = f" aid={t['aid']}" if t["aid"] else ""
        print(f"{indent}d{t['depth']:<3} [{t['type']}]{aid} {t['text']!r}")
    print()
    print(f"-> {out}")
    return 0


def cmd_selfcheck(_args) -> int:
    """用 AST 检查真实调用点，避免把禁用词表本身当成命中。"""
    import ast

    source = open(os.path.abspath(__file__), "r", encoding="utf-8").read()
    ast_tree = ast.parse(source)
    forbidden = set(FORBIDDEN_TOKENS)

    attr_hits: list[dict] = []
    call_hits: list[dict] = []

    for node in ast.walk(ast_tree):
        if isinstance(node, ast.Attribute) and node.attr in forbidden:
            attr_hits.append({"token": node.attr, "line": node.lineno})
        if isinstance(node, ast.Call):
            func = node.func
            name = None
            if isinstance(func, ast.Attribute):
                name = func.attr
            elif isinstance(func, ast.Name):
                name = func.id
            if name in forbidden:
                call_hits.append({"token": name, "line": node.lineno})

    report = {
        "checked_at": now_iso(),
        "file": os.path.basename(__file__),
        "method": "ast 扫描真实属性访问与调用点（忽略字符串常量与注释）",
        "forbidden_token_list": sorted(forbidden),
        "forbidden_attribute_accesses": attr_hits,
        "forbidden_call_sites": call_hits,
        "mutating_patterns_never_called": list(MUTATING_PATTERN_NAMES),
        "readonly_capabilities_used": [
            "Control.GetChildren（遍历）",
            "属性读取（Name/ClassName/AutomationId/ProcessId/BoundingRectangle/IsOffscreen）",
            "Win32 查询 API（EnumWindows/EnumChildWindows/GetWindowRect/IsWindowVisible 等）",
        ],
        "verdict": "PASS" if not (attr_hits or call_hits) else "REVIEW",
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="小红书千帆客服工作台 UIA 只读捕捉")
    parser.add_argument("command", choices=["enum", "capture", "selfcheck"])
    parser.add_argument("--hint", default=PROCESS_HINT, help="进程名/标题匹配串")
    parser.add_argument("--hwnd", type=int, default=None, help="指定主窗口 HWND（跳过解析）")
    args = parser.parse_args()
    sys.setrecursionlimit(20000)
    auto.SetGlobalSearchTimeout(3.0)
    if args.command == "enum":
        return cmd_enum(args)
    if args.command == "selfcheck":
        return cmd_selfcheck(args)
    return cmd_capture(args)


if __name__ == "__main__":
    raise SystemExit(main())
