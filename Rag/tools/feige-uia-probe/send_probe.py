#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""飞鸽发送通路：只读侦察（inspect）+ 受控单次发送（send）。

⚠️ 与只读探针分离
------------------
本脚本是**唯一的写操作模块**。`feige_probe.py` / `feige_extract.py` 等探针保持
纯只读，其 `selfcheck` 的只读自证不受影响。

`send` 会真实发送消息给真实客户，**发出后无法撤回**。因此：
  1. 必须先跑 `inspect` 确认输入框可写、发送按钮可定位；
  2. `send` 默认 dry-run，只有显式加 `--confirm-send` 才真正发出；
  3. 发送前会回读输入框内容做比对，内容不一致就中止，不发送；
  4. 只发送一次，不重试、不循环。

用法
----
  python send_probe.py inspect
  python send_probe.py send --text "你好"                 # dry-run，只填入不发送
  python send_probe.py send --text "你好" --confirm-send  # 真正发送
  python send_probe.py verify                             # 回读消息列表确认已发出
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

import uiautomation as auto

from feige_extract import build_tree, descendants, resolve_render_host, safe, normalize_text

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")

INPUT_AID = "im-input-box"
SEND_LABELS = ("发 送", "发送")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# 只读侦察
# --------------------------------------------------------------------------

def _describe_live(control, depth: int = 0, max_depth: int = 6) -> list[dict]:
    """对活动 UIA 控件枚举关键可写属性（只读属性查询，不修改任何状态）。"""
    rows: list[dict] = []
    if control is None or depth > max_depth:
        return rows

    def flag(name: str):
        return safe(lambda: getattr(control, name)(), None)

    rows.append({
        "depth": depth,
        "type": safe(lambda: control.ControlTypeName, "") or "",
        "aid": safe(lambda: control.AutomationId, "") or "",
        "name": normalize_text(safe(lambda: control.Name, "") or "")[:40],
        "class": safe(lambda: control.ClassName, "") or "",
        "enabled": bool(safe(lambda: control.IsEnabled, False)),
        "focusable": bool(safe(lambda: control.IsKeyboardFocusable, False)),
        "value_pattern": flag("IsValuePatternAvailable"),
        "text_pattern": flag("IsTextPatternAvailable"),
        "invoke_pattern": flag("IsInvokePatternAvailable"),
        "legacy_pattern": flag("IsLegacyIAccessiblePatternAvailable"),
        "readonly": safe(lambda: control.GetValuePattern().IsReadOnly, None),
    })
    for child in safe(lambda: control.GetChildren(), []) or []:
        rows.extend(_describe_live(child, depth + 1, max_depth))
    return rows


def find_input_control():
    """按 automation_id 定位输入框控件（活动 UIA）。"""
    host = resolve_render_host()
    found = []

    def walk(node, depth: int):
        if depth > 45 or found:
            return
        if (safe(lambda: node.AutomationId, "") or "") == INPUT_AID:
            found.append(node)
            return
        for child in safe(lambda: node.GetChildren(), []) or []:
            walk(child, depth + 1)
            if found:
                return

    walk(host["control"], 0)
    return host, (found[0] if found else None)


def cmd_inspect(_args: argparse.Namespace) -> int:
    host, control = find_input_control()
    print(f"渲染宿主 hwnd={host['render_host_hwnd']}")
    if control is None:
        print(f"未找到 automation_id={INPUT_AID} 的控件")
        return 1

    rows = _describe_live(control)
    print(f"输入框子树共 {len(rows)} 个节点：\n")
    print(f"{'深度':<5}{'类型':<18}{'aid':<26}{'可写':<6}{'只读':<6}{'可聚焦':<7}{'可用':<5} 文本")
    print("-" * 100)
    for row in rows:
        print(f"{row['depth']:<5}{row['type']:<18}{row['aid'][:24]:<26}"
              f"{str(row['value_pattern']):<6}{str(row['readonly']):<6}"
              f"{str(row['focusable']):<7}{str(row['enabled']):<5} {row['name']}")

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "send_inspect.json"), "w", encoding="utf-8") as fh:
        json.dump({"at": now_iso(), "rows": rows}, fh, ensure_ascii=False, indent=2)
    return 0


# --------------------------------------------------------------------------
# 发送
# --------------------------------------------------------------------------

def _try_value_pattern(control):
    """直接尝试取 ValuePattern，不用 IsValuePatternAvailable()。

    实测该 IsXxxAvailable() 系列方法在本机 Chromium 上会返回 None（调用失败），
    据此判断会把「实际可写」的编辑框误判为不可写。改为直接取 Pattern 并检查
    IsReadOnly，失败即视为不可写。
    """
    try:
        pattern = control.GetValuePattern()
    except Exception:
        return None, None
    read_only = True
    try:
        read_only = bool(pattern.IsReadOnly)
    except Exception:
        read_only = True
    return pattern, read_only


def _try_invoke(control) -> bool:
    try:
        control.GetInvokePattern()
        return True
    except Exception:
        return False


def _read_input_text(edit_control) -> str:
    pattern, _ = _try_value_pattern(edit_control)
    if pattern is not None:
        value = safe(lambda: pattern.Value, "") or ""
        if value:
            return normalize_text(value)
    name = normalize_text(safe(lambda: edit_control.Name, "") or "")
    # 空输入框会显示占位符（形如"发送给 xxx，使用Enter 发送消息"），不算内容
    if "发送给" in name and "Enter" in name:
        return ""
    return name


def cmd_send(args: argparse.Namespace) -> int:
    host, box = find_input_control()
    if box is None:
        print(f"未找到输入框（aid={INPUT_AID}），中止。")
        return 1

    # 在输入框子树里找可写的编辑控件与发送按钮
    edit = None
    candidates = []
    for child in descendants_live(box):
        pattern, read_only = _try_value_pattern(child)
        if pattern is not None:
            candidates.append((child, read_only))
            if edit is None and not read_only:
                edit = child

    # 发送按钮：必须排除容器本身（im-input-box 的名字也含 "发 送"），
    # 且名字去掉空格后精确等于 "发送"，取面积最小的那个（真正的按钮）。
    send_candidates = []
    for child in descendants_live(box):
        if child is box:
            continue
        name = normalize_text(safe(lambda: child.Name, "") or "").replace(" ", "")
        if name != "发送":
            continue
        if not _try_invoke(child):
            continue
        rect = safe(lambda: child.BoundingRectangle, None)
        area = 10 ** 9
        if rect is not None:
            area = (safe(lambda: rect.width(), 0) or 0) * (safe(lambda: rect.height(), 0) or 0)
        send_candidates.append((area, child))

    print(f"发送按钮候选（面积, 类型）: "
          f"{[(a, safe(lambda c=c: c.ControlTypeName, '') or '') for a, c in send_candidates]}")
    send_button = min(send_candidates, key=lambda x: x[0])[1] if send_candidates else None

    print(f"ValuePattern 候选: "
          f"{[(safe(lambda c=c: c.ControlTypeName, '') or '', ro) for c, ro in candidates]}")
    if edit is None:
        print("未找到「可写」的编辑控件，中止（不会改动界面）。")
        return 2

    print(f"可写编辑控件: type={safe(lambda: edit.ControlTypeName, '')!r} "
          f"aid={safe(lambda: edit.AutomationId, '')!r}")
    print(f"发送按钮: {'已定位' if send_button else '未定位（将尝试回车）'}")

    before = _read_input_text(edit)
    print(f"输入框原内容长度: {len(before)}")

    # 写入
    pattern, _ = _try_value_pattern(edit)
    try:
        pattern.SetValue(args.text)
    except Exception as exc:  # noqa: BLE001
        print(f"✗ SetValue 失败: {exc}")
        return 3
    time.sleep(0.5)
    after = _read_input_text(edit)

    print(f"写入后内容长度: {len(after)}（期望 {len(normalize_text(args.text))}）")
    if normalize_text(after) != normalize_text(args.text):
        print("✗ 回读内容与目标不一致，已中止，不会发送。")
        print(f"  实际读到: {after[:60]!r}")
        return 4
    print("✓ 回读一致，输入框内容正确")

    if not args.confirm_send:
        print("\n[DRY-RUN] 未发送。加 --confirm-send 才会真正发出。")
        print("注意：文字已留在输入框里。")
        return 0

    # 真正发送
    if send_button is not None:
        try:
            send_button.GetInvokePattern().Invoke()
            mechanism = "InvokePattern(发送按钮)"
        except Exception as exc:  # noqa: BLE001
            print(f"发送按钮 Invoke 失败: {exc}")
            return 5
    else:
        safe(lambda: edit.SetFocus(), None)
        time.sleep(0.3)
        auto.SendKeys("{Enter}", waitTime=0.05)
        mechanism = "SendKeys(Enter)"

    time.sleep(2.0)
    remaining = _read_input_text(edit)
    print(f"发送方式: {mechanism}")
    print(f"发送后输入框长度: {len(remaining)}（0 表示已清空，通常说明发送成功）")
    print("→ 接着运行 `python send_probe.py verify` 回读消息列表确认。")
    return 0


def descendants_live(control):
    stack = [control]
    while stack:
        node = stack.pop(0)
        yield node
        for child in safe(lambda: node.GetChildren(), []) or []:
            stack.append(child)


def cmd_verify(_args: argparse.Namespace) -> int:
    """回读消息列表，确认消息是否真的出现在会话里。"""
    from feige_extract import extract_messages, snapshot
    state = snapshot()
    print(f"当前会话消息数: {state['message_count']}")
    for msg in state["messages"]:
        print(f"  #{msg['order']:>2} [{msg['direction']:<6}] t={msg['time_text']:<9} "
              f"sender={msg['sender_masked']:<6} len={msg['content_length']:<4} "
              f"read={msg['read_state'] or '-':<3} 依据={msg['direction_basis']}")
    out = os.path.join(OUT_DIR, "send_verify.json")
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)
    print(f"\n-> {out}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="飞鸽发送通路（写操作，单独隔离）")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("inspect", help="只读侦察输入框可写性与发送按钮")
    a.set_defaults(func=cmd_inspect)

    b = sub.add_parser("send", help="填入并可选发送（默认 dry-run）")
    b.set_defaults(func=cmd_send)
    b.add_argument("--text", required=True)
    b.add_argument("--confirm-send", action="store_true",
                   help="真正发送给客户（不可撤回）")

    c = sub.add_parser("verify", help="回读消息列表确认")
    c.set_defaults(func=cmd_verify)
    return p


def main() -> int:
    args = build_parser().parse_args()
    auto.SetGlobalSearchTimeout(1)
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
