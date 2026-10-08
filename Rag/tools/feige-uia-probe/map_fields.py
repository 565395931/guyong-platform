#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按 automation_id / 关键字定位并打印元素子树，用于把界面结构映射为采集字段。

用法:
  python map_fields.py raw/tree_renderhost_raw.json --aid imroot
  python map_fields.py raw/tree_renderhost_raw.json --aid chantListScrollArea --depth 6
  python map_fields.py raw/tree_renderhost_raw.json --list-aids
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("path")
    p.add_argument("--aid", default=None, help="按 automation_id 精确定位")
    p.add_argument("--match", default=None, help="按 automation_id 子串匹配")
    p.add_argument("--depth", type=int, default=5, help="子树打印深度")
    p.add_argument("--max-nodes", type=int, default=400)
    p.add_argument("--list-aids", action="store_true", help="列出所有 automation_id")
    p.add_argument("--text-only", action="store_true", help="只打印有文字的节点")
    return p.parse_args()


def walk_all(node: dict):
    yield node
    for child in node.get("children", []):
        yield from walk_all(child)


def find(node: dict, pred):
    out = []
    for n in walk_all(node):
        if pred(n):
            out.append(n)
    return out


def show(node: dict, depth: int, max_depth: int, counter: list, max_nodes: int,
         text_only: bool) -> None:
    if depth > max_depth or counter[0] >= max_nodes:
        return
    counter[0] += 1

    text = node.get("text") or {}
    raw = text.get("raw", "")
    if not text_only or raw:
        indent = "  " * depth
        aid = f" aid={node['automation_id']}" if node.get("automation_id") else ""
        rect = node.get("rect") or {}
        geom = f"@{rect.get('left')},{rect.get('top')} {rect.get('width')}x{rect.get('height')}" if rect else ""
        label = f" {raw!r}" if raw else ""
        print(f"{indent}- {node.get('type')}{aid} kids={node.get('child_count', 0)} {geom}{label}")

    for child in node.get("children", []):
        show(child, depth + 1, max_depth, counter, max_nodes, text_only)


def main() -> int:
    args = parse_args()
    if not os.path.exists(args.path):
        print(f"找不到文件: {args.path}")
        return 1

    with open(args.path, "r", encoding="utf-8") as fh:
        tree = json.load(fh)["tree"]

    if args.list_aids:
        for n in walk_all(tree):
            if n.get("automation_id"):
                raw = (n.get("text") or {}).get("raw", "")
                print(f"{n.get('type'):<18} {n['automation_id']:<44} {raw[:40]!r}")
        return 0

    if args.aid:
        targets = find(tree, lambda n: n.get("automation_id") == args.aid)
    elif args.match:
        targets = find(tree, lambda n: args.match in (n.get("automation_id") or ""))
    else:
        print("需要 --aid 或 --match 或 --list-aids")
        return 1

    if not targets:
        print(f"未找到匹配节点 (aid={args.aid} match={args.match})")
        return 1

    for i, target in enumerate(targets[:3]):
        print(f"===== 命中 {i + 1}/{len(targets)}: "
              f"aid={target.get('automation_id')} type={target.get('type')} =====")
        show(target, 0, args.depth, [0], args.max_nodes, args.text_only)
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
