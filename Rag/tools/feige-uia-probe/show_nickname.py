#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""显示当前会话的客户昵称原文，并复现客户键的派生过程，用于定位键变化的原因。

只读。默认会打印未脱敏的昵称（这是本机排查用途，不要提交其输出）。
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from feige_extract import (
    _is_conversation_item, build_tree, descendants, digest12,
    extract_conversation_list, normalize_text, resolve_render_host, subtree_texts,
)


def raw_texts(node, depth=0, acc=None):
    """收集子树里所有非空文本（不做脱敏），按文档序。"""
    if acc is None:
        acc = []
    name = node.get("name") or ""
    if name:
        acc.append(name)
    for child in node.get("children", []):
        raw_texts(child, depth + 1, acc)
    return acc


def raw_nicknames(tree):
    """按会话项结构取出未脱敏昵称（右支首个文本），顺序与 extract_conversation_list 一致。"""
    out = []
    for node in descendants(tree):
        if not _is_conversation_item(node):
            continue
        _left, right = node["children"]
        texts = subtree_texts(right)
        out.append(texts[0] if texts else "")
    return out


def main() -> int:
    host = resolve_render_host()
    control = host["control"]

    # 预热：Chromium 首次为某个窗口构建无障碍树是异步的，刚附加时可能整棵树是空的
    # （实测会出现 0 个会话项）。等"连续两次节点数一致"再读，否则会把空树当成
    # "没有客户"，得到完全错误的结论。
    import time
    previous = None
    tree = {}
    for attempt in range(40):
        tree = build_tree(control)
        size = sum(1 for _ in descendants(tree))
        if previous is not None and size == previous and size > 0:
            break
        previous = size
        time.sleep(0.5)

    shop_title = host["shop_title"]
    shop_name = shop_title.replace("[商家]", "").strip()

    print("=" * 66)
    print("窗口标题        :", shop_title)
    print("店铺名（去前缀）:", repr(shop_name))
    print("店铺名 digest12 :", digest12(shop_name))
    print("元素树节点数    :", sum(1 for _ in descendants(tree)), f"（采样 {attempt + 1} 次）")
    print("=" * 66)

    convs = extract_conversation_list(tree)
    raw_names = raw_nicknames(tree)
    print(f"\n会话项 {len(convs)} 个：")
    for idx, item in enumerate(convs):
        raw = raw_names[idx] if idx < len(raw_names) else ""
        print(f"  [{item['index']}] 昵称原文 = {raw!r}")
        print(f"      昵称 digest12 = {item['nickname_redacted']['digest']}"
              f"  (长度 {item['nickname_redacted']['length']}, {item['nickname_redacted']['kind']})")
        print(f"      未读 = {item['unread_badge']}  时间 = {item['relative_time']!r}"
              f"  预览 {item['preview_count']} 行")

    # 复现客户键派生：与 bridge_node.build_inbound / feige_send.current_customer_key 一致
    if convs:
        customer_digest = convs[0]["nickname_redacted"]["digest"]
        composed = f"{shop_name}|{customer_digest}"
        customer_key = digest12(composed)
        print("\n" + "=" * 66)
        print("客户键派生（当前打开会话 = 会话列表第 0 项）")
        print("  拼接原文       :", repr(composed))
        print("  客户键 digest12:", customer_key)
    else:
        print("\n没有解析到会话项，无法派生客户键")
        customer_key = None

    print("\n" + "=" * 66)
    print("顶栏（topbar）里的客户相关文本，用于交叉核对：")
    for node in descendants(tree):
        aid = node.get("automation_id") or ""
        if aid in ("topbar-left-info", "topbar-sec-container", "topbar-third-container"):
            texts = [t for t in raw_texts(node) if t][:8]
            print(f"  {aid}: {texts}")
    print("=" * 66)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
