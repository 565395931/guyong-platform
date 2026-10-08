#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打印最新出站消息的原文，用于核对实际发出的内容。只读。"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from feige_extract import (  # noqa: E402
    ABS_TIME_RE, READ_STATES, SENT_BY_HINTS, _trim_blocks, build_tree,
    descendants, normalize_text, resolve_render_host, subtree_texts,
)


def main() -> int:
    host = resolve_render_host()
    tree = build_tree(host["control"])
    blocks = _trim_blocks(tree)

    print(f"消息块数: {len(blocks)}")
    for i, block in enumerate(blocks):
        texts = subtree_texts(block)
        stamps = [t for t in texts if ABS_TIME_RE.match(t)]
        if not stamps:
            continue
        if i < len(blocks) - 3:
            continue  # 只看最后三个块
        print(f"\n--- 块 {i} 时间={stamps[0]} ---")
        print(f"  块内全部文本节点（{len(texts)} 个）:")
        for t in texts:
            tag = ""
            if t in READ_STATES:
                tag = " [已读态]"
            elif ABS_TIME_RE.match(t):
                tag = " [时间]"
            elif any(h in t for h in SENT_BY_HINTS):
                tag = " [发送方说明]"
            elif t == "头像":
                tag = " [头像]"
            print(f"    len={len(t):<4}{tag} {t!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
