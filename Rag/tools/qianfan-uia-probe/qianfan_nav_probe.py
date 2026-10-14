#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""千帆客户端诊断：视图识别、渲染宿主分布、导航项可用性（只读，不点击）。

用于排查自动化前的客户端状态。生产点击逻辑在 `qianfan_orders.py`
（元素级 UIA 动作，零坐标）；本工具只看不点。

  python qianfan_nav_probe.py inspect

输出：
- 主窗口与渲染宿主分布（在可见主窗口下 / 被缩进隐藏容器 —— 后者意味着
  UIA 动作不可用，需提窗恢复，见 qianfan_orders.click_nav_via_uia）；
- 当前视图（内容标记判断）；
- 各导航项的 DefaultAction / InvokePattern 可用性。
"""

from __future__ import annotations

import argparse
import ctypes
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uiautomation as auto  # noqa: E402
from qianfan_capture import (  # noqa: E402
    attach_render_host, enum_child_hwnds, enum_top_level, get_class_name,
    get_pid, get_window_text, resolve_main_window,
)
from qianfan_orders import collect_texts_of, detect_view, find_nav_item, rect_of  # noqa: E402

user32 = ctypes.WinDLL("user32", use_last_error=True)

NAV_NAMES = ("客服", "智能客服", "数据", "管理", "订单")
PATTERN_LEGACY, PATTERN_INVOKE = 10018, 10000


def safe(fn, default=None):
    try:
        return fn()
    except Exception:  # noqa: BLE001
        return default


def hosting_state(pid: int) -> dict:
    visible_parent, hidden_hosts = None, []
    for hwnd in enum_top_level():
        if get_pid(hwnd) != pid:
            continue
        hosts = [c for c in enum_child_hwnds(hwnd)
                 if get_class_name(c) == "Chrome_RenderWidgetHostHWND"]
        if not hosts:
            continue
        if user32.IsWindowVisible(hwnd) and get_class_name(hwnd) == "Chrome_WidgetWin_1":
            visible_parent = {"hwnd": hwnd, "hosts": hosts}
        else:
            hidden_hosts.append({"hwnd": hwnd, "hosts": hosts})
    return {"visible_parent": visible_parent, "hidden_hosts": hidden_hosts}


def cmd_inspect(_args) -> int:
    main = resolve_main_window()
    print(f"主窗口: hwnd={main['hwnd']} title={main['title']!r} rect={main['rect']}")
    if main["minimized"] or not main["visible"]:
        print("⚠️ 窗口不可见/最小化（读不到也点不到）")
        return 2

    state = hosting_state(main["pid"])
    print()
    print("渲染宿主分布:")
    if state["visible_parent"]:
        print(f"  ✅ 在可见主窗口下: {state['visible_parent']['hosts']}（UIA 动作应可用）")
    else:
        print("  ⚠️ 无宿主挂在可见主窗口下（UIA 动作不可用，需提窗恢复）")
    for entry in state["hidden_hosts"]:
        print(f"  隐藏容器 hwnd={entry['hwnd']} hosts={entry['hosts']}")

    resolved = attach_render_host(main["hwnd"])
    ctrl = resolved["control"]
    texts = collect_texts_of(ctrl)
    print()
    print(f"选中渲染宿主: hwnd={resolved['render_host_hwnd']} doc={ctrl.Name!r} "
          f"nodes={resolved['stats']['nodes']}")
    print(f"当前视图: {detect_view(texts)}（文本 {len(texts)} 条）")
    fg = user32.GetForegroundWindow()
    print(f"当前前台: hwnd={fg} {get_window_text(fg)[:24]!r}")

    print()
    print("导航项可用性:")
    for name in NAV_NAMES:
        item = find_nav_item(ctrl, name, window_rect=main["rect"])
        if item is None:
            print(f"  [{name}] 未找到")
            continue
        legacy = safe(lambda: item.GetPattern(PATTERN_LEGACY), None)
        invoke = safe(lambda: item.GetPattern(PATTERN_INVOKE), None)
        action = safe(lambda: legacy.DefaultAction, "") if legacy else ""
        print(f"  [{name}] rect={rect_of(item)} "
              f"legacy={'有' if legacy is not None else '无'}(action={action!r}) "
              f"invoke={'有' if invoke is not None else '无'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="千帆客户端诊断（只读）")
    parser.add_argument("command", choices=["inspect"])
    args = parser.parse_args()
    sys.setrecursionlimit(20000)
    auto.SetGlobalSearchTimeout(3.0)
    return cmd_inspect(args)


if __name__ == "__main__":
    raise SystemExit(main())
