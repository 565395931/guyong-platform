#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断指纹不稳定：多次快照并逐条比对，找出漂移的消息。

只读。
"""

from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from feige_extract import snapshot  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")


def key(msg: dict) -> str:
    return f"{msg['time_text']}|{msg['sender_key']}|{msg['content_digest']}|{msg['content_length']}"


def main() -> int:
    rounds = []
    for i in range(3):
        state = snapshot()
        rounds.append(state)
        print(f"--- 轮 {i + 1}: {state['message_count']} 条 ---")
        for msg in state["messages"]:
            print(f"  #{msg['order']:>2} t={msg['time_text']:<9} dir={msg['direction']:<7} "
                  f"len={msg['content_length']:<4} occ={msg.get('occurrence')} "
                  f"sha={msg['content_digest']} fp={msg['fingerprint'][:12]}")
        if i < 2:
            time.sleep(3)

    print()
    print("=== 逐条差异 ===")
    maxn = max(len(r["messages"]) for r in rounds)
    unstable = []
    for idx in range(maxn):
        variants = []
        for r in rounds:
            msgs = r["messages"]
            variants.append(key(msgs[idx]) if idx < len(msgs) else "<缺失>")
        unique = sorted(set(variants))
        if len(unique) > 1:
            unstable.append(idx)
            print(f"  #{idx} 不稳定（{len(unique)} 种）:")
            for v in unique:
                print(f"      {v}")
    if not unstable:
        print("  无差异：所有消息字段跨轮一致")

    payload = {
        "rounds": len(rounds),
        "message_counts": [r["message_count"] for r in rounds],
        "unstable_indices": unstable,
        "detail": [
            {
                "order": idx,
                "variants": sorted({
                    (r["messages"][idx]["time_text"] + "|" + r["messages"][idx]["content_digest"]
                     + "|" + str(r["messages"][idx]["content_length"]))
                    for r in rounds if idx < len(r["messages"])
                }),
            }
            for idx in range(maxn)
        ],
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, "diagnose_fp.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    print(f"\n-> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
