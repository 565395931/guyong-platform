#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""测量与诊断工具（只读）。

子命令
------
  warmup    测量从附加到元素树稳定所需的时间（预热期）
  convlist  打印所有会话项候选的结构细节，用于判断误匹配
"""

from __future__ import annotations

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from feige_extract import (  # noqa: E402
    _is_conversation_item, _is_message_block, build_tree, descendants,
    extract_conversation_list, has_image_named, mask_nickname,
    resolve_render_host, subtree_texts,
)


def tree_size(tree: dict) -> tuple:
    nodes = list(descendants(tree))
    return (
        len(nodes),
        sum(1 for n in nodes if n["name"]),
        sum(1 for n in nodes if _is_message_block(n)),
    )


def cmd_warmup(args: argparse.Namespace) -> int:
    """每次用全新进程重新附加，测量树稳定的耗时。"""
    host = resolve_render_host()
    control = host["control"]

    t0 = time.monotonic()
    samples = []
    prev = None
    stable_at = None

    for i in range(args.max_samples):
        tree = build_tree(control)
        size = tree_size(tree)
        elapsed = time.monotonic() - t0
        samples.append((round(elapsed, 2), size))
        print(f"  t={elapsed:6.2f}s  总节点={size[0]:<5} 文本节点={size[1]:<5} 消息块={size[2]}")

        if prev is not None and size == prev and stable_at is None:
            stable_at = elapsed
            if args.stop_on_stable:
                break
        prev = size
        time.sleep(args.interval)

    print()
    if stable_at is None:
        print(f"在 {args.max_samples} 次采样内未观测到连续两次一致（间隔 {args.interval}s）")
    else:
        print(f"★ 稳定耗时（首次连续两次一致）: {stable_at:.2f}s")
    sizes = [s for _, s in samples]
    print(f"节点数取值范围: {min(x[0] for x in sizes)} ~ {max(x[0] for x in sizes)}")
    print(f"消息块取值范围: {min(x[2] for x in sizes)} ~ {max(x[2] for x in sizes)}")
    return 0


def cmd_convlist(args: argparse.Namespace) -> int:
    host = resolve_render_host()
    tree = build_tree(host["control"])

    print(f"渲染宿主 hwnd={host['render_host_hwnd']}")
    print()
    print("=== 会话项结构候选 ===")
    n = 0
    for node in descendants(tree):
        if not _is_conversation_item(node):
            continue
        left, right = node["children"]
        rect = node.get("rect") or {}
        lr, rr = left.get("rect") or {}, right.get("rect") or {}
        print(f"[{n}] rect=@{rect.get('left')},{rect.get('top')} "
              f"{rect.get('width')}x{rect.get('height')}")
        print(f"    左支 {lr.get('width')}x{lr.get('height')} @x={lr.get('left')} "
              f"含头像={has_image_named(left, '头像')}")
        print(f"      左支文本: {[mask_nickname(t) for t in subtree_texts(left)][:6]}")
        print(f"    右支 {rr.get('width')}x{rr.get('height')} @x={rr.get('left')}")
        print(f"      右支文本: {[mask_nickname(t) for t in subtree_texts(right)][:6]}")
        n += 1

    parsed = extract_conversation_list(tree)
    print()
    print(f"候选数={n}  解析出的会话数={len(parsed)}")
    for item in parsed:
        print(f"  [{item['index']}] {item['nickname_masked']} "
              f"未读={item['unread_badge']} 时间={item['relative_time']!r} "
              f"预览{item['preview_count']}行 rect={item.get('rect')}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    w = sub.add_parser("warmup")
    w.add_argument("--interval", type=float, default=0.5)
    w.add_argument("--max-samples", type=int, default=40)
    w.add_argument("--stop-on-stable", action="store_true")
    w.set_defaults(func=cmd_warmup)

    c = sub.add_parser("convlist")
    c.set_defaults(func=cmd_convlist)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
