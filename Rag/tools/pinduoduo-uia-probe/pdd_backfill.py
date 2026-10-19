#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""拼多多客服聊天「历史回翻」：向上滚动逐屏读取，识别到重复上下文即停，最后滚回底部。

思路（按用户建议）：不盲翻到底——每读取一屏就与已收集内容做指纹去重，
连续两屏没有新内容（到顶，或整屏都与已读完全重复）就停止；读完把滚动条还原到底部。

用法：
  python pdd_backfill.py [--max-scrolls 40] [--json out/pdd_history.json] [--ingest]
  --ingest 时额外产出 out/pdd_ingest_payloads.json（与实时上报同一指纹格式，可直接入库且天然去重）
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pdd_client as pc  # noqa: E402
from pdd_reader import (  # noqa: E402
    CHAT_BOX, OUT_DIR, apply_direction_by_color, image_size, masked_customer_name,
    ocr_region, parse_middle_chat, read_conversation_title,
)

user32 = ctypes.windll.user32
MOUSEEVENTF_WHEEL = 0x0800
NOTCHES_PER_PAGE = 3   # 步长小于一屏 → 相邻两屏有重叠，保证不漏


def read_viewport(main: dict, scale: int) -> list[dict]:
    img = pc.capture_window(main["hwnd"])
    img2 = img.resize((img.width * scale, img.height * scale)) if scale != 1 else img
    png = os.path.join(OUT_DIR, "pdd_capture.png")
    img2.save(png)
    W, H = image_size(main, scale)
    parsed = parse_middle_chat(ocr_region(png, CHAT_BOX, scale, extra_zoom=2), W, H)
    apply_direction_by_color(png, parsed["messages"], scale)
    return [m for m in parsed["messages"]
            if not re.match(r"^\d{1,2}:\d{2}$", m["text"].strip())]


def wheel(notches: int) -> None:
    for _ in range(abs(notches)):
        user32.mouse_event(MOUSEEVENTF_WHEEL, 0, 0, 120 if notches > 0 else -120, 0)
        time.sleep(0.06)


def main() -> int:
    parser = argparse.ArgumentParser(description="拼多多聊天历史回翻")
    parser.add_argument("--max-scrolls", type=int, default=40)
    parser.add_argument("--json", default=None)
    parser.add_argument("--ingest", action="store_true")
    args = parser.parse_args()

    pc.ensure_dpi_aware()
    main = pc.find_main_window()
    if main is None:
        print("未找到拼多多工作台主窗口")
        return 3
    pc.raise_window(main["hwnd"])
    time.sleep(0.8)

    name = masked_customer_name(read_conversation_title(main, 2)) or "未知客户"
    key = f"pdd:{name}"
    print(f"当前会话: {name!r}")

    # 先点开会话回到最新，再从最新往上翻（否则中途开始会漏下半段）
    try:
        from pdd_reader import PddChatReader
        _r = PddChatReader(scale=2)
        _m, _l = _r._snapshot(focus="panel")
        if _r._click_by_name(_m, name, _l):
            print("已点开会话回到最新")
            time.sleep(1.2)
    except Exception as exc:  # noqa: BLE001
        print(f"点开会话失败({type(exc).__name__})，从当前位置开始翻")

    # 光标放到聊天区中心（滚轮要落在聊天区上）
    cx = main["rect"]["left"] + int(main["rect"]["width"] * 0.45)
    cy = main["rect"]["top"] + int(main["rect"]["height"] * 0.45)
    user32.SetCursorPos(cx, cy)
    time.sleep(0.3)

    # ---- 第 1 步：滚到最顶（"没有更多了"）----
    print("先滚到顶…")
    top_reached = False
    for _ in range(30):
        wheel(NOTCHES_PER_PAGE)
        time.sleep(0.5)
        try:
            msgs = read_viewport(main, 2)
        except Exception:  # noqa: BLE001
            continue
        texts = {m["text"] for m in msgs}
        if any("没有更多" in t for t in texts):
            top_reached = True
            break
    print("已到顶" if top_reached else "未探测到'没有更多了'，按当前屏开始（可能已在顶部附近）")
    time.sleep(0.5)

    # ---- 第 2 步：从上往下逐屏读（步长小于一屏 → 有重叠，不漏）----
    collected: list[dict] = []   # 旧 → 新（自然顺序，无需反转）
    seen: set[str] = set()
    quiet = 0
    for step in range(args.max_scrolls):
        try:
            msgs = read_viewport(main, 2)
        except Exception as exc:  # noqa: BLE001
            print(f"第{step + 1}屏读取失败: {type(exc).__name__}: {exc}")
            break
        counters: dict[tuple, int] = {}
        fresh = 0
        for m in msgs:
            token = (m["direction"], m["text"])
            occ = counters.get(token, 0)
            counters[token] = occ + 1
            fp = hashlib.sha256(f"pdd|{key}|{m['direction']}||{m['text']}|{occ}".encode()).hexdigest()[:32]
            if fp in seen:
                continue
            seen.add(fp)
            fresh += 1
            collected.append({"direction": m["direction"], "text": m["text"], "fp": fp})
        print(f"第{step + 1}屏: {len(msgs)} 条（新增 {fresh}）")
        if fresh == 0:
            quiet += 1
            if quiet >= 2:
                print("连续两屏无新内容 → 判定已到底")
                break
        else:
            quiet = 0
        wheel(-NOTCHES_PER_PAGE)   # 向下滚
        time.sleep(1.0)

    # 回到最新：优先"重新点开会话"（DOM 会定位到底部，最可靠），兜底滚轮下翻
    try:
        from pdd_reader import PddChatReader
        reader = PddChatReader(scale=2)
        panel_main, panel_lines = reader._snapshot(focus="panel")
        clicked = reader._click_by_name(panel_main, name, panel_lines)
        print("已重新点开会话回到最新" if clicked else "点开会话失败，回退滚轮下翻")
        if not clicked and scrolls:
            wheel(-scrolls * NOTCHES_PER_PAGE)
    except Exception as exc:  # noqa: BLE001
        print(f"回到底部失败({type(exc).__name__})，回退滚轮下翻")
        if scrolls:
            wheel(-scrolls * NOTCHES_PER_PAGE)
    time.sleep(0.8)

    print(f"共收集 {len(collected)} 条（按旧→新）:")
    for m in collected:
        print(f"  [{m['direction']:>3}] {m['text'][:70]!r}")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({"conversationKey": key, "userName": name,
                       "messages": collected}, fh, ensure_ascii=False, indent=2)
        print(f"-> {args.json}")

    if args.ingest:
        payloads = []
        for i, m in enumerate(collected):
            payloads.append({
                "accountId": 5, "channel": "pinduoduo",
                "platformConversationId": key, "platformCustomerId": key,
                "channelMessageId": m["fp"], "userName": name,
                "content": m["text"], "messageType": "text", "media": [],
                "platformPayload": {"direction": m["direction"], "batchIndex": i,
                                    "source": "pinduoduo.workbench.backfill"},
            })
        out = os.path.join(OUT_DIR, "pdd_ingest_payloads.json")
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(payloads, fh, ensure_ascii=False)
        print(f"-> {out}（{len(payloads)} 条，与实时上报同指纹格式，入库自动去重）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
