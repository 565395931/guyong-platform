#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""飞鸽可读界面（悬浮小组件 / 商家消息窗口）字段读取与指纹稳定性验证。

背景
----
主窗口（[商家]<店铺名>）在当前桌面状态下被其它窗口遮挡，Chromium 不为其构建
无障碍树，因此会话列表与当前会话正文暂不可读（见 a11y_matrix.py 与报告）。
但抖店工作台的"悬浮小组件"和"商家消息窗口"（新消息浮窗）始终置顶、未被遮挡，
UIA 可完整读取。本脚本在这两个界面上验证：

  1. 店铺名、未读/待处理计数能否读取；
  2. 客户昵称、消息预览、时间标签能否读取；
  3. 消息指纹在重复读取下是否稳定；
  4. 界面变化（新消息浮窗出现/计数变化）能否被轮询监听捕获。

指纹稳定性实验设计
------------------
浮窗右侧显示的是**相对时间**（"1小时"），会随时间漂移。因此同时计算：
  fp_v1 = 含相对时间标签
  fp_v2 = 不含相对时间标签
重复读取后比较两者，判定哪个可作为稳定的 channelMessageId 替代。

只读：仅 UIA 读取，不点击、不输入、不发送、不修改窗口状态。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

import uiautomation as auto

from feige_probe import (
    ADAPTER_ID,
    Redacted,
    digest12,
    mask_nickname,
    message_fingerprint,
    normalize_text,
    rect_of,
    safe,
    sha256_hex,
    target_window,
)
from win_enum import EnumWindowsProc, get_class_name, get_window_text, user32

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")


def iter_top_level_windows():
    """按 z 序枚举顶层窗口 (hwnd, class, title)。纯 Win32 查询，速度快。"""
    hwnds: list[int] = []

    def collect(hwnd, _lparam):
        hwnds.append(int(hwnd))
        return True

    user32.EnumWindows(EnumWindowsProc(collect), 0)
    for hwnd in hwnds:
        yield hwnd, get_class_name(hwnd), get_window_text(hwnd)


WIDGET_TITLE_RE = re.compile(r"悬浮小组件")
TOAST_TITLE_RE = re.compile(r"商家消息窗口")
TIME_LABEL_RE = re.compile(r"^\d+\s*(秒|分钟|小时|天|月)|^刚刚|^昨天|^星期")

# 悬浮小组件的导航项标签 -> 语义
WIDGET_TABS = {
    "接待": "pending_service",
    "通知": "notifications",
    "待发货": "pending_shipment",
    "待售后": "pending_aftersale",
    "首页": "home",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def find_window_by_title(pattern: re.Pattern) -> Optional[Any]:
    """按标题正则定位顶层 Chromium 窗口（只读）。

    使用 Win32 EnumWindows + GetWindowTextW 做筛选，比遍历 UIA 根子节点快得多；
    只有命中目标后才附加 UIA，避免对上百个无关窗口逐个触发 UIA 属性读取。
    """
    for hwnd, cls, title in iter_top_level_windows():
        if cls != "Chrome_WidgetWin_1":
            continue
        if pattern.search(title):
            return safe(lambda: auto.ControlFromHandle(hwnd), None)
    return None


def leaves_with_geometry(control: Any, max_depth: int = 20) -> list[dict]:
    """收集叶子文本节点及其几何位置，按阅读顺序（先上后左）排序。"""
    out: list[dict] = []

    def walk(node: Any, depth: int) -> None:
        if depth > max_depth:
            return
        children = safe(lambda: node.GetChildren(), []) or []
        if not children:
            text = normalize_text(safe(lambda: node.Name, "") or "")
            rect = rect_of(node)
            if text and rect:
                out.append({
                    "text": text,
                    "top": rect["top"],
                    "left": rect["left"],
                    "width": rect["width"],
                    "height": rect["height"],
                    "type": safe(lambda: node.ControlTypeName, "") or "",
                })
            return
        for child in children:
            walk(child, depth + 1)

    walk(control, 0)
    out.sort(key=lambda item: (item["top"], item["left"]))
    return out


# --------------------------------------------------------------------------
# 悬浮小组件
# --------------------------------------------------------------------------

def read_widget() -> dict:
    win = find_window_by_title(WIDGET_TITLE_RE)
    if win is None:
        return {"found": False, "reason": "悬浮小组件窗口未找到"}

    nodes = leaves_with_geometry(win)
    texts = [n["text"] for n in nodes]

    # 店铺名：第一个较长中文文本，且不是导航标签
    shop_raw = ""
    for text in texts:
        if text in WIDGET_TABS:
            continue
        if len(text) >= 2 and not text.startswith("要获取缺失"):
            shop_raw = text
            break

    # 导航徽标：形如 "1" 且其后（同列）是导航标签
    badges: dict[str, dict] = {}
    for node in nodes:
        label = node["text"]
        if label not in WIDGET_TABS:
            continue
        # 在同一列、位于标签上方的数字节点即为徽标
        best = None
        for cand in nodes:
            if not re.fullmatch(r"\d{1,4}", cand["text"]):
                continue
            if cand["top"] >= node["top"]:
                continue
            if abs(cand["left"] - node["left"]) > 40:
                continue
            if best is None or cand["top"] > best["top"]:
                best = cand
        badges[WIDGET_TABS[label]] = {
            "label": label,
            "count": int(best["text"]) if best else None,
            "present": best is not None,
        }

    return {
        "found": True,
        "hwnd": safe(lambda: win.NativeWindowHandle, 0) or 0,
        "title_masked": mask_nickname(safe(lambda: win.Name, "") or ""),
        "shop_masked": mask_nickname(shop_raw),
        "shop_redacted": asdict(Redacted.of(shop_raw)),
        "badges": badges,
        "pending_service": badges.get("pending_service", {}).get("count"),
        "text_node_count": len(nodes),
    }


# --------------------------------------------------------------------------
# 商家消息窗口（新消息浮窗）
# --------------------------------------------------------------------------

def read_toast() -> dict:
    win = find_window_by_title(TOAST_TITLE_RE)
    if win is None:
        return {"found": False, "reason": "商家消息窗口未出现（无新消息浮窗）"}

    nodes = leaves_with_geometry(win)
    texts = [n["text"] for n in nodes]

    # 头部："待回复（" + 数字 + "）"
    pending = None
    header_label = ""
    for node in nodes:
        if node["text"].startswith("待回复"):
            header_label = node["text"]
            for cand in nodes:
                if re.fullmatch(r"\d{1,3}", cand["text"]) and abs(cand["top"] - node["top"]) <= 6:
                    pending = int(cand["text"])
                    break
            break

    # 正文区：昵称（顶行左）、时间（顶行右）、消息正文（第二行）
    body = [n for n in nodes if n["top"] > (nodes[0]["top"] if nodes else 0)]
    body = [n for n in body if not n["text"].startswith(("待回复", "）", "关闭"))]
    body = [n for n in body if not re.fullmatch(r"\d{1,3}", n["text"])]

    nickname_raw = ""
    time_text = ""
    content_raw = ""
    if body:
        row_top = body[0]["top"]
        top_row = [n for n in body if abs(n["top"] - row_top) <= 4]
        lower = [n for n in body if n["top"] > row_top]
        time_nodes = [n for n in top_row if TIME_LABEL_RE.search(n["text"])]
        name_nodes = [n for n in top_row if n not in time_nodes]
        if name_nodes:
            nickname_raw = max(name_nodes, key=lambda n: len(n["text"]))["text"]
        if time_nodes:
            time_text = time_nodes[0]["text"]
        if lower:
            content_raw = max(lower, key=lambda n: len(n["text"]))["text"]

    return {
        "found": True,
        "hwnd": safe(lambda: win.NativeWindowHandle, 0) or 0,
        "title_masked": mask_nickname(safe(lambda: win.Name, "") or ""),
        "pending_label": header_label,
        "pending_count": pending,
        "sender_masked": mask_nickname(nickname_raw),
        "sender_redacted": asdict(Redacted.of(nickname_raw)),
        "time_text": time_text,
        "content_redacted": asdict(Redacted.of(content_raw)),
        "content_digest": digest12(normalize_text(content_raw)),
        "content_length": len(normalize_text(content_raw)),
        "text_node_count": len(nodes),
    }


# --------------------------------------------------------------------------
# 指纹
# --------------------------------------------------------------------------

def toast_message_rows(widget: dict, toast: dict) -> list[dict]:
    """把浮窗可见的一条消息转换为指纹记录（双版本指纹）。"""
    if not toast.get("found"):
        return []

    sender_key = digest12(toast["sender_redacted"]["digest"] + "|sender")
    conv_key = digest12(
        (widget.get("shop_masked") or "") + "|" + toast["sender_redacted"]["digest"]
    )
    content = normalize_text(toast.get("content_digest", ""))

    base_parts = [ADAPTER_ID, "toast", conv_key, "in", sender_key, content]
    fp_v2 = sha256_hex("\x1f".join(base_parts))                     # 不含时间
    fp_v1 = sha256_hex("\x1f".join(base_parts + [toast.get("time_text") or ""]))  # 含时间

    return [{
        "surface": "toast",
        "conversation_key": conv_key,
        "sender_key": sender_key,
        "time_text": toast.get("time_text", ""),
        "content_length": toast.get("content_length", 0),
        "content_digest": content,
        "fingerprint_with_time": fp_v1,
        "fingerprint_without_time": fp_v2,
        "pending_count": toast.get("pending_count"),
    }]


def snapshot_state() -> dict:
    widget = read_widget()
    toast = read_toast()
    return {
        "at": now_iso(),
        "widget": widget,
        "toast": toast,
        "messages": toast_message_rows(widget, toast),
        "widget_signature": json.dumps(widget.get("badges", {}), ensure_ascii=False, sort_keys=True),
        "toast_signature": json.dumps(
            {k: toast.get(k) for k in ("pending_count", "sender_redacted", "content_digest", "time_text")},
            ensure_ascii=False, sort_keys=True,
        ) if toast.get("found") else "",
    }


# --------------------------------------------------------------------------
# 子命令
# --------------------------------------------------------------------------

def ensure_out() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)


def cmd_surfaces(args: argparse.Namespace) -> int:
    state = snapshot_state()
    ensure_out()
    out = args.out or os.path.join(OUT_DIR, "surfaces.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)

    widget, toast = state["widget"], state["toast"]
    print("=== 悬浮小组件 ===")
    if widget.get("found"):
        print(f"  店铺: {widget['shop_masked']}  (len={widget['shop_redacted']['length']} "
              f"sha={widget['shop_redacted']['digest']})")
        for key, info in widget["badges"].items():
            print(f"  {key:<18} 标签={info['label']} 计数={info['count']}")
    else:
        print(f"  未找到: {widget.get('reason')}")

    print("\n=== 商家消息窗口 ===")
    if toast.get("found"):
        print(f"  待回复: {toast['pending_label']}{toast['pending_count']}）")
        print(f"  客户昵称: {toast['sender_masked']} "
              f"(len={toast['sender_redacted']['length']} sha={toast['sender_redacted']['digest']})")
        print(f"  时间标签: {toast['time_text']!r}")
        print(f"  消息正文: len={toast['content_length']} sha={toast['content_digest']}")
    else:
        print(f"  未找到: {toast.get('reason')}")

    print(f"\n=== 指纹 ===")
    for row in state["messages"]:
        print(f"  v1(含时间)={row['fingerprint_with_time'][:16]}")
        print(f"  v2(不含时间)={row['fingerprint_without_time'][:16]}")
    print(f"\n-> {out}")
    return 0


def cmd_dedupe(args: argparse.Namespace) -> int:
    rounds: list[dict] = []
    for i in range(args.rounds):
        state = snapshot_state()
        rounds.append(state)
        widget, toast = state["widget"], state["toast"]
        print(f"轮 {i + 1}: 店铺={widget.get('shop_masked')} "
              f"接待={widget.get('pending_service')} "
              f"浮窗={toast.get('found')} "
              f"待回复={toast.get('pending_count')} "
              f"时间={toast.get('time_text')!r} "
              f"正文sha={toast.get('content_digest')}")
        if i + 1 < args.rounds:
            time.sleep(args.interval)

    def collect(key: str) -> list[set]:
        return [
            {row[key] for row in r["messages"]}
            for r in rounds
        ]

    v1_sets = collect("fingerprint_with_time")
    v2_sets = collect("fingerprint_without_time")

    def stable_of(sets: list[set]) -> Optional[bool]:
        non_empty = [s for s in sets if s]
        if len(non_empty) < 2:
            return None
        return all(s == non_empty[0] for s in non_empty[1:])

    v1_stable = stable_of(v1_sets)
    v2_stable = stable_of(v2_sets)

    # 去重账本：累计入库，统计被指纹拦下的重复
    def ledger_stats(sets: list[set]) -> dict:
        ledger: set = set()
        dupes = 0
        for s in sets:
            for fp in s:
                if fp in ledger:
                    dupes += 1
                else:
                    ledger.add(fp)
        return {"ledger_size": len(ledger), "duplicates_prevented": dupes}

    payload = {
        "generated_at": now_iso(),
        "rounds": args.rounds,
        "interval_seconds": args.interval,
        "time_labels_observed": [r["toast"].get("time_text") for r in rounds if r["toast"].get("found")],
        "message_counts": [len(r["messages"]) for r in rounds],
        "v1_with_time": {
            "stable": v1_stable,
            "unique_per_round": [len(s) for s in v1_sets],
            **ledger_stats(v1_sets),
        },
        "v2_without_time": {
            "stable": v2_stable,
            "unique_per_round": [len(s) for s in v2_sets],
            **ledger_stats(v2_sets),
        },
        "rounds_detail": [
            {
                "at": r["at"],
                "widget_shop_masked": r["widget"].get("shop_masked"),
                "badges": r["widget"].get("badges"),
                "toast_time_text": r["toast"].get("time_text"),
                "toast_pending": r["toast"].get("pending_count"),
                "toast_content_digest": r["toast"].get("content_digest"),
                "content_length": r["toast"].get("content_length"),
                "fingerprints": r["messages"],
            }
            for r in rounds
        ],
    }
    ensure_out()
    out = args.out or os.path.join(OUT_DIR, "dedupe_surfaces.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    print()
    print(f"时间标签观测值: {payload['time_labels_observed']}")
    print(f"v1(含相对时间) 跨轮稳定: {v1_stable}  唯一数={payload['v1_with_time']['unique_per_round']}")
    print(f"v2(不含相对时间) 跨轮稳定: {v2_stable}  唯一数={payload['v2_without_time']['unique_per_round']}")
    print(f"\n-> {out}")

    if args.self_check:
        # 自检：同一时刻连续两次读取，指纹必须完全一致（否则提取逻辑不稳定）
        a = snapshot_state()
        b = snapshot_state()
        same_v2 = {r["fingerprint_without_time"] for r in a["messages"]} == \
                  {r["fingerprint_without_time"] for r in b["messages"]}
        print(f"同一时刻连续两次读取 v2 指纹一致: {same_v2}")
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    print(f"开始监听 {args.seconds}s（间隔 {args.interval}s）…")
    baseline = snapshot_state()
    known = {r["fingerprint_without_time"] for r in baseline["messages"]}
    prev_sig = (baseline["widget_signature"], baseline["toast_signature"])
    events: list[dict] = []
    print(f"基线：浮窗={baseline['toast'].get('found')} "
          f"接待={baseline['widget'].get('pending_service')} "
          f"消息指纹={len(known)} 个")

    deadline = time.time() + args.seconds
    while time.time() < deadline:
        time.sleep(args.interval)
        state = snapshot_state()
        cur = {r["fingerprint_without_time"] for r in state["messages"]}
        new_fps = sorted(cur - known)
        gone_fps = sorted(known - cur)
        sig = (state["widget_signature"], state["toast_signature"])
        changed = sig != prev_sig

        if new_fps or gone_fps or changed:
            event = {
                "at": state["at"],
                "new_message_fingerprints": new_fps,
                "removed_message_fingerprints": gone_fps,
                "widget_changed": state["widget_signature"] != prev_sig[0],
                "toast_changed": state["toast_signature"] != prev_sig[1],
                "pending_service": state["widget"].get("pending_service"),
                "toast_present": state["toast"].get("found"),
                "toast_time_text": state["toast"].get("time_text"),
                "content_length": state["toast"].get("content_length"),
                "content_digest": state["toast"].get("content_digest"),
            }
            events.append(event)
            print(f"  [{state['at']}] +{len(new_fps)} 新消息, -{len(gone_fps)}, "
                  f"小组件变化={event['widget_changed']}, 浮窗变化={event['toast_changed']}, "
                  f"接待={event['pending_service']}")
            known = cur
            prev_sig = sig

    payload = {
        "generated_at": now_iso(),
        "duration_seconds": args.seconds,
        "interval_seconds": args.interval,
        "mechanism": "UIA 轮询比对（小组件徽标签名 + 浮窗指纹集合）",
        "baseline_pending_service": baseline["widget"].get("pending_service"),
        "baseline_toast_present": baseline["toast"].get("found"),
        "detected_changes": len(events),
        "events": events,
    }
    ensure_out()
    out = args.out or os.path.join(OUT_DIR, "watch_surfaces.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    print(f"\n检测到 {len(events)} 次界面变化 -> {out}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="飞鸽可读界面字段与指纹验证（只读）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("surfaces", help="读取当前可读界面字段")
    p.set_defaults(func=cmd_surfaces)
    p.add_argument("--out", default=None)

    p = sub.add_parser("dedupe", help="验证指纹跨轮稳定性")
    p.set_defaults(func=cmd_dedupe)
    p.add_argument("--rounds", type=int, default=3)
    p.add_argument("--interval", type=float, default=1.0)
    p.add_argument("--self-check", action="store_true", help="追加同一时刻双读一致性检查")
    p.add_argument("--out", default=None)

    p = sub.add_parser("watch", help="轮询监听界面变化")
    p.set_defaults(func=cmd_watch)
    p.add_argument("--seconds", type=float, default=60.0)
    p.add_argument("--interval", type=float, default=1.0)
    p.add_argument("--out", default=None)

    return parser


def main() -> int:
    args = build_parser().parse_args()
    # 全局搜索超时压到 1s：避免在无关或阻塞窗口上长时间等待
    auto.SetGlobalSearchTimeout(1)
    # 行缓冲，保证重定向到文件或后台运行时日志不丢失
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    ensure_out()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
