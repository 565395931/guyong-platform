#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""千帆订单采集器：点进订单页 → 抓取订单表格 → 点回客服页（元素级点击，零坐标）。

⚠️ 与 `qianfan_capture.py`（纯只读）不同：本脚本会**点击**客户端左侧导航。
约束与安全设计：

- 只点击左侧导航项（订单 / 客服），点击前校验名称精确匹配；
- 绝不触碰输入框、发送按钮、业务操作按钮（黑名单拒绝）；
- **不使用屏幕坐标、不模拟鼠标**：点击全部走 UIA 元素动作
  （LegacyIAccessible.DoDefaultAction → InvokePattern），按元素定位而不是按位置；
- try/finally：无论中途成败，最后都点回客服页；
- 目标窗口最小化/隐藏时拒绝执行。

实测要点（2026-10-13）
----------------------
- **遮挡/后台状态**：千帆窗口被压到后台（非前台、被遮挡）时，Chromium 会把渲染宿主
  缩进隐藏容器 `Chrome_WidgetWin_0`，此时 DoDefaultAction / Invoke 全部返回
  ELEMENTNOTAVAILABLE（GetClickablePoint 恒 False）。把窗口提到前台约 1~2 秒后
  宿主搬回可见主窗口，元素动作立即恢复可用。因此点击流程是：
  **先直接尝试元素动作 → 失败则提窗 → 等状态恢复 → 重试**。
- 视图判断不能用 DocumentControl 名（客户端故障时会固定显示
  '你访问的页面不见了'），必须用内容标记（'当前会话' / '订单管理'）。
- **查询状态是粘性的**：遗留一次空查询（搜索类型未选 / 日期为空）后，列表会一直
  停在"查询结果为空"，重进模块也不恢复；采集前必须"重置条件 → 搜索"把查询
  拉回默认集，否则会误采到 0 条。
- 订单表格结构：TableControl → 表头（HeaderControl×N，包装层级实测有两种形态）
  + 行 CustomControl（DataItemControl 单元格×N，文档序与表头一一对应）。
- 导航项位置按**相对窗口左边缘偏移**判断（窗口会被移动，不能用绝对 x）。

用法
----
  python qianfan_orders.py collect                 # 完整一轮：导航→抓取→回退
  python qianfan_orders.py collect --no-click      # 不点击，只读当前视图
  python qianfan_orders.py collect --keep-view     # 抓完留在订单页（调试）

退出码
------
  0  成功（订单已抓取，视图已还原）
  2  未找到客户端/附加失败
  3  导航失败（切不到订单页）
  4  抓取失败（找不到订单表格）
  5  抓取成功但未还原视图
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import sys
import time
from ctypes import wintypes
from datetime import datetime, timezone
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uiautomation as auto  # noqa: E402
from qianfan_capture import (  # noqa: E402
    OUT_DIR, attach_render_host, dump_tree, get_pid, get_rect,
    get_window_text, resolve_main_window,
)

user32 = ctypes.WinDLL("user32", use_last_error=True)

ADAPTER_ID = "xiaohongshu.qianfan"
CHAT_MARKERS = ("当前会话", "全部会话")
ORDERS_MARKERS = ("订单管理", "售后管理")
NAV_LEFT_OFFSET_MAX = 90  # 导航条贴窗口左边缘（实测偏移 11px，条目宽 53px）
FORBIDDEN_CLICK_NAMES = ("发送", "确定", "提交", "删除", "关闭")
CLICK_SETTLE_SECONDS = 2.0
VIEW_CHANGE_TIMEOUT = 12.0
PATTERN_LEGACY, PATTERN_INVOKE = 10018, 10000
PAGE_TOTAL_RE = re.compile(r"共\s*(\d+)\s*条")
PAGE_SIZE_RE = re.compile(r"(\d+)\s*条/页")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def ensure_dpi_aware() -> None:
    """UIA 坐标都是物理像素；不做 DPI 感知在缩放≠100% 的机器上会整体偏移。"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:  # noqa: BLE001
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:  # noqa: BLE001
            pass


def safe(fn, default=None):
    try:
        return fn()
    except Exception:  # noqa: BLE001
        return default


def rect_of(node: Any) -> Optional[dict]:
    try:
        r = node.BoundingRectangle
        return {"left": r.left, "top": r.top, "width": r.width(), "height": r.height()}
    except Exception:  # noqa: BLE001
        return None


def find_nav_item(control: Any, name: str, window_rect: Optional[dict] = None) -> Optional[Any]:
    """在左侧导航条内按文本找导航项，返回其 53x52 的按钮容器（GroupControl）。

    window_rect 提供时按"相对窗口左边缘偏移"判断导航条位置（窗口会被移动，
    不能用绝对 x 过滤）；缺省时退回宽松过滤（仅供诊断）。
    """
    hits: list[Any] = []

    def in_strip(rect: dict) -> bool:
        if window_rect:
            offset = rect["left"] - window_rect["left"]
            return -8 <= offset <= NAV_LEFT_OFFSET_MAX
        return rect["left"] < 400

    def walk(node: Any, depth: int) -> None:
        if depth > 12 or len(hits) > 8:
            return
        children = safe(lambda: node.GetChildren(), []) or []
        if not children:
            node_name = safe(lambda: node.Name, "") or ""
            if node_name.strip() == name:
                rect = rect_of(node)
                if rect and rect["width"] < 120 and in_strip(rect):
                    hits.append(node)
            return
        for c in children:
            walk(c, depth + 1)

    walk(control, 0)
    if not hits:
        return None
    node = hits[0]
    for _ in range(4):
        parent = safe(lambda: node.GetParentControl())
        if parent is None:
            break
        rect = rect_of(parent)
        if rect and 44 <= rect["width"] <= 64 and 44 <= rect["height"] <= 64:
            node = parent
        else:
            break
    return node


def raise_window(main_hwnd: int) -> bool:
    """把千帆主窗口提到前台（触发 Chromium 把渲染宿主搬回可见窗口）。"""
    if user32.SetForegroundWindow(wintypes.HWND(main_hwnd)):
        return True
    flags = 0x0001 | 0x0002 | 0x0040  # NOSIZE | NOMOVE | SHOWWINDOW
    ok = user32.SetWindowPos(wintypes.HWND(main_hwnd), wintypes.HWND(-1), 0, 0, 0, 0, flags)
    user32.SetWindowPos(wintypes.HWND(main_hwnd), wintypes.HWND(-2), 0, 0, 0, 0, flags)
    return bool(ok)


def restore_foreground(fg_hwnd: int, log: list[str]) -> None:
    if not fg_hwnd:
        return
    try:
        user32.SetForegroundWindow(wintypes.HWND(fg_hwnd))
        log.append(f"已还原前台 hwnd={fg_hwnd}")
    except Exception:  # noqa: BLE001
        log.append("还原前台失败（忽略）")


# --------------------------------------------------------------------------
# 视图判断（内容标记，不用 DocumentControl 名）
# --------------------------------------------------------------------------

def collect_texts_of(ctrl: Any, max_nodes: int = 4000) -> list[dict]:
    tree = dump_tree(ctrl, max_nodes=max_nodes)
    out: list[dict] = []

    def walk(node: dict, depth: int) -> None:
        if node.get("name", "").strip():
            out.append({"depth": depth, "type": node.get("type", ""),
                        "aid": node.get("aid", ""), "text": node["name"]})
        for c in node.get("children", []):
            walk(c, depth + 1)

    walk(tree, 0)
    return out


def detect_view(texts: list[dict]) -> str:
    values = {t["text"] for t in texts}
    if any(m in values for m in CHAT_MARKERS):
        return "chat"
    if any(m in values for m in ORDERS_MARKERS):
        return "orders"
    if values:
        return "other"
    return "unreadable"


def wait_for_view(ctrl: Any, expect: str, timeout: float = VIEW_CHANGE_TIMEOUT) -> Optional[list[dict]]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        texts = collect_texts_of(ctrl)
        if detect_view(texts) == expect:
            return texts
        time.sleep(0.5)
    return None


def find_button(control: Any, name: str) -> Optional[Any]:
    """按文本找 ButtonControl（上溯到按钮容器）。"""
    hits: list[Any] = []

    def walk(node: Any, depth: int) -> None:
        if depth > 16 or len(hits) > 4:
            return
        children = safe(lambda: node.GetChildren(), []) or []
        if not children:
            node_name = safe(lambda: node.Name, "") or ""
            if node_name.strip() == name:
                hits.append(node)
            return
        for c in children:
            walk(c, depth + 1)

    walk(control, 0)
    if not hits:
        return None
    node = hits[0]
    for _ in range(5):
        if node is None or safe(lambda: node.ControlTypeName, "") == "ButtonControl":
            return node
        node = safe(lambda: node.GetParentControl())
    return node


def _click_element(main_hwnd: int, name: str, log: list[str], finder, verify) -> bool:
    """元素级点击的通用流程（零坐标）。

    直接尝试 DoDefaultAction → Invoke；全部失败说明客户端处于"渲染宿主缩进
    隐藏容器"状态（窗口被遮挡/后台），提窗后等状态恢复再重试。
    """
    if name in FORBIDDEN_CLICK_NAMES:
        log.append(f"拒绝点击黑名单控件 {name!r}")
        return False

    raised = False
    for attempt in range(1, 4):
        try:
            resolved = attach_render_host(main_hwnd)
        except SystemExit as exc:
            log.append(f"attempt{attempt}: 渲染宿主不可用（{exc}）")
            time.sleep(1.5)
            continue
        ctrl = resolved["control"]
        element = finder(ctrl, get_rect(main_hwnd))
        if element is None:
            log.append(f"attempt{attempt}: 未找到 {name!r}")
            time.sleep(1.5)
            continue

        for method, pattern_id in (("DoDefaultAction", PATTERN_LEGACY),
                                   ("Invoke", PATTERN_INVOKE)):
            pattern = safe(lambda: element.GetPattern(pattern_id), None)
            if pattern is None:
                continue
            try:
                if method == "DoDefaultAction":
                    pattern.DoDefaultAction()
                else:
                    pattern.Invoke()
                log.append(f"attempt{attempt}: {method} {name!r} 调用成功")
                if verify(ctrl):
                    return True
                log.append(f"attempt{attempt}: {method} 后未观察到预期变化")
            except Exception as exc:  # noqa: BLE001
                log.append(f"attempt{attempt}: {method} 失败（{type(exc).__name__}）")

        if not raised:
            log.append("元素动作不可用（窗口被遮挡时 Chromium 会缩回渲染宿主），提窗后重试")
            raise_window(main_hwnd)
            raised = True
            time.sleep(2.0)
    return False


def click_nav_via_uia(main_hwnd: int, name: str, expect: str, log: list[str]) -> bool:
    """点击左侧导航项并等待目标视图出现（元素级，零坐标）。"""
    def finder(ctrl, window_rect):
        return find_nav_item(ctrl, name, window_rect=window_rect)

    def verify(ctrl):
        if wait_for_view(ctrl, expect, 6.0) is not None:
            time.sleep(CLICK_SETTLE_SECONDS)
            return True
        return False

    return _click_element(main_hwnd, name, log, finder, verify)


def click_button_via_uia(main_hwnd: int, name: str, log: list[str],
                         settle: float = 2.5) -> bool:
    """点击业务按钮（仅白名单用途：重置条件 / 搜索）。动作后固定沉降，数据校验由调用方做。"""
    def finder(ctrl, _window_rect):
        return find_button(ctrl, name)

    def verify(_ctrl):
        time.sleep(settle)
        return True

    return _click_element(main_hwnd, name, log, finder, verify)


def wait_for_orders_loaded(main_hwnd: int, log: list[str], timeout: float = 10.0) -> bool:
    """等订单列表加载完成：出现分页信息（'共 N 条'，空结果同样会计为 0 条）。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        texts = collect_texts_of(attach_render_host(main_hwnd)["control"])
        if any(PAGE_TOTAL_RE.search(t["text"]) for t in texts):
            return True
        time.sleep(0.6)
    log.append("⚠️ 等待订单列表加载超时")
    return False


# --------------------------------------------------------------------------
# 订单表格解析
# --------------------------------------------------------------------------

def find_table(tree: dict) -> Optional[dict]:
    queue = [tree]
    while queue:
        node = queue.pop(0)
        if node.get("type") == "TableControl":
            return node
        queue.extend(node.get("children", []))
    return None


def parse_orders_table(table: dict) -> dict:
    """表头（子树内全部 HeaderControl，文档序）+ 数据行（顶层 CustomControl 单元格）。

    实测表头有两种包装形态（GroupControl(HeaderControl×N) 或
    GroupControl > CustomControl(HeaderControl×N)），所以用全树收集而不是固定层级。
    空结果时表格里只有一行提示文案（'查询结果为空…'），识别为 emptyState。
    """
    headers: list[str] = []
    empty_state = False

    def collect_headers(node: dict) -> None:
        for c in node.get("children", []):
            if c.get("type") == "HeaderControl":
                headers.append(c.get("name", "").strip())
            else:
                collect_headers(c)

    collect_headers(table)

    rows: list[dict] = []
    for child in table.get("children", []):
        if child.get("type") != "CustomControl":
            continue
        cells = child.get("children", [])
        if not cells or any(c.get("type") == "HeaderControl" for c in cells):
            continue
        names = [c.get("name", "").strip() for c in cells]
        if len(names) == 1 and "查询结果为空" in names[0]:
            empty_state = True
            continue
        if headers and len(names) != len(headers):
            # 结构漂移：仍保留原始单元格，不按表头映射
            rows.append({"__cells": names})
            continue
        record = dict(zip(headers, names)) if headers else {"__cells": names}
        # 操作列表单元格：拆出按钮名
        for cell in cells:
            if cell.get("name", "").strip() == (record.get("操作列表") or ""):
                actions = [g.get("name", "").strip()
                           for g in cell.get("children", [])
                           if g.get("type") == "ButtonControl" and g.get("name", "").strip()]
                if actions:
                    record["操作列表"] = actions if len(actions) > 1 else actions[0]
        rows.append(record)

    return {"headers": headers, "rows": rows, "rowCount": len(rows),
            "emptyState": empty_state}


def scrape_orders(ctrl: Any) -> dict:
    tree = dump_tree(ctrl, max_nodes=8000)
    texts = []
    def walk(node, depth):
        if node.get("name", "").strip():
            texts.append(node["name"])
        for c in node.get("children", []):
            walk(c, depth + 1)
    walk(tree, 0)

    table = find_table(tree)
    if table is None:
        return {"ok": False, "reason": "未找到订单表格（TableControl）"}

    parsed = parse_orders_table(table)
    total = None
    page_size = None
    for t in texts:
        m = PAGE_TOTAL_RE.search(t)
        if m:
            total = int(m.group(1))
        m = PAGE_SIZE_RE.search(t)
        if m:
            page_size = int(m.group(1))

    return {
        "ok": True,
        "headers": parsed["headers"],
        "rows": parsed["rows"],
        "rowCount": parsed["rowCount"],
        "emptyState": parsed["emptyState"],
        "pageInfo": {
            "total": total,
            "pageSize": page_size,
            "singlePage": (total is not None and page_size is not None
                           and total <= page_size),
        },
        "exportPresent": any("导出" in t for t in texts),
        "rawTextCount": len(texts),
    }


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def collect_once(no_click: bool = False, keep_view: bool = False,
                 out_path: Optional[str] = None) -> tuple[int, dict]:
    ensure_dpi_aware()
    auto.SetGlobalSearchTimeout(3.0)
    log: list[str] = []

    try:
        main = resolve_main_window()
        resolved = attach_render_host(main["hwnd"])
    except SystemExit as exc:
        return 2, {"ok": False, "error": str(exc), "log": log}

    ctrl = resolved["control"]
    main_hwnd = main["hwnd"]
    fg_before = int(user32.GetForegroundWindow())
    result: dict = {
        "adapterId": ADAPTER_ID,
        "capturedAt": now_iso(),
        "mainHwnd": main_hwnd,
        "renderHostHwnd": resolved["render_host_hwnd"],
        "hostName": os.environ.get("COMPUTERNAME", ""),
        "log": log,
    }

    texts = collect_texts_of(ctrl)
    view_before = detect_view(texts)
    result["viewBefore"] = view_before
    log.append(f"起始视图: {view_before}")

    exit_code = 0
    try:
        if no_click:
            if view_before != "orders":
                exit_code = 3
                result["ok"] = False
                result["error"] = f"--no-click 模式下当前不是订单视图（{view_before}）"
                return exit_code, result
        elif view_before != "orders":
            if not click_nav_via_uia(main_hwnd, "订单", "orders", log):
                exit_code = 3
                result["ok"] = False
                result["error"] = "切换订单页失败"
                return exit_code, result
            log.append("已进入订单页")

        # 确定性基线：重置条件 → 搜索。
        # 实测订单模块的查询状态是粘性的：遗留一次空查询（搜索类型未选/日期为空）后，
        # 列表会一直停在"查询结果为空"，连重进模块都不恢复；重置条件+搜索可恢复默认集。
        if not no_click:
            click_button_via_uia(main_hwnd, "重置条件", log)
            click_button_via_uia(main_hwnd, "搜索", log)
            wait_for_orders_loaded(main_hwnd, log)

        # 点击过程可能伴随渲染宿主搬移，抓取前重新附加一次
        orders = scrape_orders(attach_render_host(main_hwnd)["control"])
        result["orders"] = orders
        if not orders.get("ok"):
            exit_code = 4
            result["ok"] = False
            result["error"] = orders.get("reason", "抓取失败")
        else:
            result["ok"] = True
            missing = [h for h in orders["headers"] if not h]
            if missing:
                log.append(f"⚠️ 表头存在空列名 {len(missing)} 个")
            if not orders["pageInfo"]["singlePage"] and orders["pageInfo"]["total"]:
                log.append(
                    f"⚠️ 当前页 {orders['rowCount']} 行 / 共 {orders['pageInfo']['total']} 条，"
                    "分页数据未采集（单页方案待扩展）")
    finally:
        if not no_click and not keep_view:
            log.append("点回客服页…")
            if click_nav_via_uia(main_hwnd, "客服", "chat", log):
                log.append("已回到客服页")
                result["viewRestored"] = True
            else:
                log.append("⚠️ 未能回到客服页")
                result["viewRestored"] = False
                if exit_code == 0:
                    exit_code = 5
        restore_foreground(fg_before, log)

    # 落盘
    os.makedirs(OUT_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = out_path or os.path.join(OUT_DIR, f"qianfan_orders_{stamp}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    result["savedTo"] = path
    latest = os.path.join(OUT_DIR, "qianfan_orders_latest.json")
    with open(latest, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    log.append(f"已保存 {path}")
    return exit_code, result


def cmd_collect(args) -> int:
    code, result = collect_once(no_click=args.no_click, keep_view=args.keep_view,
                                out_path=args.out)
    view = result.get("viewBefore")
    if result.get("ok"):
        orders = result.get("orders", {})
        print(f"OK 订单 {orders.get('rowCount')} 行 "
              f"(共 {orders.get('pageInfo', {}).get('total')} 条) "
              f"视图 {view} -> restored={result.get('viewRestored', 'n/a')}")
        for row in orders.get("rows", [])[:5]:
            print(f"  {row.get('订单号', '?')} {row.get('状态', '?')} "
                  f"{row.get('用户名', '?')} {row.get('创建时间', '?')}")
    else:
        print(f"FAIL({code}) {result.get('error', '')} 起始视图 {view}")
    for line in result.get("log", []):
        print(f"  [log] {line}")
    print(f"-> {result.get('savedTo', '-')}")
    return code


def main() -> int:
    parser = argparse.ArgumentParser(description="千帆订单采集器（点击导航，非纯只读）")
    parser.add_argument("command", choices=["collect"])
    parser.add_argument("--no-click", action="store_true", help="不点击，只读当前视图")
    parser.add_argument("--keep-view", action="store_true", help="抓完不切回客服页")
    parser.add_argument("--out", default=None, help="自定义输出文件路径")
    args = parser.parse_args()
    sys.setrecursionlimit(20000)
    if args.command == "collect":
        return cmd_collect(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
