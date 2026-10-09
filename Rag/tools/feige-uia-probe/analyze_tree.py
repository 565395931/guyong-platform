#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""以紧凑缩进形式打印 UIA 元素树结构，便于人工判断容器层次。

用法:
  python analyze_tree.py [tree_json] [--raw] [--max-depth N]
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import sys


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("path", nargs="?", default=os.path.join("out", "tree_redacted.json"))
    p.add_argument("--raw", action="store_true", help="打印未脱敏文本")
    p.add_argument("--max-depth", type=int, default=99)
    p.add_argument("--summary", action="store_true", help="只打印统计")
    p.add_argument("--ext", action="store_true", help="打印扩展 UIA 属性（语义/位置/方向）")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    if not os.path.exists(args.path):
        print(f"找不到文件: {args.path}")
        return 1

    with open(args.path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    tree = data["tree"]

    types: collections.Counter = collections.Counter()
    classes: collections.Counter = collections.Counter()
    aids: collections.Counter = collections.Counter()
    kinds: collections.Counter = collections.Counter()

    def tally(node: dict) -> None:
        types[node.get("type", "")] += 1
        classes[node.get("class", "")] += 1
        if node.get("automation_id"):
            aids[node["automation_id"]] += 1
        text = node.get("text") or {}
        if isinstance(text, dict):
            kinds[text.get("kind", "?")] += 1
        for child in node.get("children", []):
            tally(child)

    tally(tree)

    print("=" * 70)
    print(f"文件: {args.path}   脱敏: {data.get('redacted')}")
    print(f"节点总数: {sum(types.values())}")
    print("=" * 70)
    print("\n-- 控件类型 --")
    for name, count in types.most_common(30):
        print(f"{count:6}  {name}")

    print("\n-- automation_id (有值的) --")
    if aids:
        for name, count in aids.most_common(30):
            print(f"{count:6}  {name}")
    else:
        print("  (无)")

    print("\n-- class --")
    for name, count in classes.most_common(15):
        print(f"{count:6}  {name}")

    print("\n-- 文本节点类型分布 --")
    for name, count in kinds.most_common(15):
        print(f"{count:6}  {name}")

    if args.summary:
        return 0

    print("\n" + "=" * 70)
    print("元素树（缩进表示层级）")
    print("=" * 70)

    def show(node: dict, depth: int) -> None:
        if depth > args.max_depth:
            return
        indent = "  " * depth
        text = node.get("text") or {}
        if args.raw:
            label = repr((text.get("raw") or "")[:60])
        else:
            length = text.get("length", 0)
            label = f"len={length} {text.get('kind', '')} #{text.get('digest', '')[:8]}" if length else ""
        rect = node.get("rect") or {}
        geom = f"@{rect.get('left')},{rect.get('top')} {rect.get('width')}x{rect.get('height')}" if rect else ""
        aid = f" aid={node['automation_id']}" if node.get("automation_id") else ""
        off = " [OFFSCREEN]" if node.get("offscreen") else ""
        kids = node.get("child_count", 0)
        trunc = " [TRUNCATED]" if node.get("children_truncated") else ""
        pat = ",".join(node.get("patterns", []))
        pats = f" pat=({pat})" if pat else ""

        extstr = ""
        if args.ext:
            ext = node.get("ext") or {}
            bits = []
            for key in ("localized_type", "item_type", "position_in_set", "size_of_set",
                        "level", "is_keyboard_focusable"):
                value = ext.get(key)
                if value not in (None, "", False):
                    bits.append(f"{key}={value}")
            for key in ("help_text", "full_description", "item_status"):
                value = ext.get(key)
                if isinstance(value, dict) and value.get("length"):
                    bits.append(f"{key}:len={value['length']}")
                elif isinstance(value, dict) and value.get("raw"):
                    bits.append(f"{key}={value['raw']!r}")
            if bits:
                extstr = " {" + " ".join(bits) + "}"

        print(f"{indent}- {node.get('type')} cls={node.get('class')}{aid} "
              f"kids={kids}{trunc} {geom} {label}{pats}{extstr}{off}")
        for child in node.get("children", []):
            show(child, depth + 1)

    show(tree, 0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
