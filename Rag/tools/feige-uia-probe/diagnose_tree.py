#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断元素树随时间的稳定性：区分「树本身衰减」与「块检测规则敏感」。

只读。
"""

from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from feige_extract import (  # noqa: E402
    ABS_TIME_RE, build_tree, count_image_named, descendants,
    extract_messages, resolve_render_host, _is_message_block,
)


def stats(tree: dict) -> dict:
    nodes = list(descendants(tree))
    return {
        "total_nodes": len(nodes),
        "text_nodes": sum(1 for n in nodes if n["name"]),
        "avatars": count_image_named(tree, "头像"),
        "timestamps": sum(1 for n in nodes if ABS_TIME_RE.match(n["name"])),
        "blocks": sum(1 for n in nodes if _is_message_block(n)),
        "messages": len(extract_messages(tree)),
    }


def main() -> int:
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    interval = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0

    host = resolve_render_host()
    print(f"渲染宿主 hwnd={host['render_host_hwnd']}")
    print(f"{'轮':<4}{'总节点':<8}{'文本节点':<10}{'头像':<8}{'时间戳':<8}{'块':<6}{'消息':<6}")
    print("-" * 50)

    rows = []
    for i in range(rounds):
        tree = build_tree(host["control"])
        s = stats(tree)
        rows.append(s)
        print(f"{i + 1:<4}{s['total_nodes']:<8}{s['text_nodes']:<10}"
              f"{s['avatars']:<8}{s['timestamps']:<8}{s['blocks']:<6}{s['messages']:<6}")
        if i + 1 < rounds:
            time.sleep(interval)

    totals = [r["total_nodes"] for r in rows]
    print()
    print(f"总节点范围: {min(totals)} ~ {max(totals)}")
    if max(totals) - min(totals) > 20:
        print("=> 树本身在变化（总节点数显著波动）")
    else:
        print("=> 树规模稳定，问题更可能在块检测规则")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
