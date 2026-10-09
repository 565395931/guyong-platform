#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分析消息块结构，寻找可用于「发送者归属 / 消息方向」的结构化信号。

只读地读取已导出的元素树 JSON。
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys

TIME_RE = re.compile(r"^\d{1,2}:\d{2}(:\d{2})?$")


def walk(node, parents=()):
    yield node, parents
    for child in node.get("children", []):
        yield from walk(child, parents + (node,))


def text_of(node) -> str:
    t = node.get("text") or {}
    return t.get("raw", "") or ""


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("path")
    p.add_argument("--blocks", action="store_true", help="打印每个消息块的结构")
    p.add_argument("--localized", action="store_true", help="统计 localized_type 取值")
    p.add_argument("--expand", type=int, default=None,
                   help="展开第 N 个时间戳所在的整个消息块子树")
    args = p.parse_args()

    with open(args.path, "r", encoding="utf-8") as fh:
        tree = json.load(fh)["tree"]

    nodes = list(walk(tree))

    if args.localized:
        counter = collections.Counter()
        for node, _ in nodes:
            lt = (node.get("ext") or {}).get("localized_type") or ""
            if lt:
                counter[lt] += 1
        print("=== localized_type 取值分布 ===")
        for name, count in counter.most_common(40):
            print(f"{count:6}  {name}")
        return 0

    # 找所有时间戳节点
    stamps = [(n, par) for n, par in nodes if TIME_RE.match(text_of(n))]
    print(f"时间戳节点数: {len(stamps)}")
    print()

    if args.expand is not None:
        if args.expand >= len(stamps):
            print(f"--expand {args.expand} 越界（共 {len(stamps)} 个时间戳）")
            return 1
        stamp, parents = stamps[args.expand]
        # 消息块根：向上第 4 层祖先（实测该层直接持有发送者标签）
        block = parents[-4] if len(parents) >= 4 else parents[0]
        print(f"===== 展开时间戳 #{args.expand}: {text_of(stamp)!r} 所在消息块 =====")

        def show(node, depth=0):
            kids = node.get("children", [])
            txt = text_of(node)
            rect = node.get("rect") or {}
            geom = f"@{rect.get('left')},{rect.get('top')} {rect.get('width')}x{rect.get('height')}" if rect else ""
            lt = (node.get("ext") or {}).get("localized_type") or ""
            label = f" {txt!r}" if txt else ""
            print(f"{'  ' * depth}- {node.get('type')} lt={lt!r} kids={len(kids)} {geom}{label}")
            for child in kids:
                show(child, depth + 1)

        show(block)
        return 0


    # 对每个时间戳，向上找「消息块」：包含该时间戳、且兄弟数量较多的那层
    for i, (stamp, parents) in enumerate(stamps[:12]):
        print(f"===== 时间戳 #{i}: {text_of(stamp)!r} 节点={stamp.get('type')} =====")
        for depth, ancestor in enumerate(reversed(parents[-4:]), start=1):
            kids = ancestor.get("children", [])
            texts = [text_of(k) for k in kids if text_of(k)]
            rect = ancestor.get("rect") or {}
            geom = f"@{rect.get('left')},{rect.get('top')} {rect.get('width')}x{rect.get('height')}"
            lt = (ancestor.get("ext") or {}).get("localized_type") or ""
            print(f"  祖先-{depth}: {ancestor.get('type')} lt={lt!r} kids={len(kids)} {geom}")
            print(f"           子文本: {texts[:14]}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
