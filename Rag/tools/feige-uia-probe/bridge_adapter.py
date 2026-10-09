#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把飞鸽抓取结果映射为 Desktop Bridge 的 message.inbound 负载。

集成接缝的最小单元测试
----------------------
本脚本不碰运行中的后端，只做一件事：把抓取到的真实消息转成《payloads.schema / bridgeProtocol》
要求的 `message.inbound` 负载，再由 validate_envelope.js 用项目自带的 zod schema 校验。
校验通过 = 抓取端与桥接协议的接口打通。

用法
----
  python bridge_adapter.py --account-id 1 --node-id <uuid> --out out/envelopes.json
  node validate_envelope.js ../rag-server/src/modules/desktop-bridge/bridgeProtocol.js out/envelopes.json <uuid>
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from feige_extract import (  # noqa: E402
    ABS_TIME_RE, REL_TIME_RE, _trim_blocks, assign_occurrences, build_tree,
    descendants, digest12, extract_conversation_list, extract_messages,
    resolve_render_host, subtree_texts,
)
from feige_extract import fingerprint as make_fingerprint  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")

CHANNEL = "doudian"

# 界面上出现但**不是真实消息**的占位文本：媒体消息只能读到这类标签，
# 读不到真实内容。
#
# ⚠️ 协议约束（由 validate_envelope.js 实测发现）：
#   bridgeProtocol 的 media.type 枚举只有 image | video | audio | file，
#   **没有 sticker / emoji 类型**。界面上的「表情」既没有 URL 也没有本地路径，
#   因此约定走**截图**通路并声明为 image（用 platformPayload.placeholder 标注
#   真实类型），这样无需改动既有协议。
MEDIA_PLACEHOLDERS = {
    "表情": "image",
    "图片": "image",
    "视频": "video",
    "语音": "audio",
    "文件": "file",
}
# 界面占位文本 -> 真实语义，写进 platformPayload 供后端区分
PLACEHOLDER_SEMANTICS = {
    "表情": "sticker",
    "图片": "image",
    "视频": "video",
    "语音": "audio",
    "文件": "file",
}


def compose_timestamp(time_text: str, observed_at: datetime) -> tuple[Optional[str], str]:
    """把界面时间标签补成 ISO 时间戳。

    界面时间有三种形态，精度不同，必须分别处理：
      1. `HH:MM:SS`  → 补当天日期，秒级（最可靠）
      2. `HH:MM`     → 补当天日期，秒归零（区分度不足，需靠 fingerprint 的 occurrence 兜底）
      3. 相对时间（`1小时` / `昨天` / `星期x`）→ 只能按观测时刻反推，标记为近似

    返回 (iso_timestamp_or_None, precision)
    """
    text = (time_text or "").strip()
    if ABS_TIME_RE.match(text):
        parts = [int(p) for p in text.split(":")]
        hour, minute = parts[0], parts[1]
        second = parts[2] if len(parts) > 2 else 0
        # 跨零点保护：界面时间晚于观测时刻超过 12 小时，说明是前一天
        candidate = observed_at.replace(hour=hour, minute=minute, second=second, microsecond=0)
        if candidate - observed_at > timedelta(hours=12):
            candidate -= timedelta(days=1)
        precision = "second" if len(parts) > 2 else "minute"
        return candidate.isoformat(timespec="seconds"), precision

    if REL_TIME_RE.match(text):
        delta = None
        if text.startswith("刚刚"):
            delta = timedelta(seconds=0)
        elif text.startswith("昨天"):
            delta = timedelta(days=1)
        else:
            num = "".join(ch for ch in text if ch.isdigit())
            if num:
                n = int(num)
                if "秒" in text:
                    delta = timedelta(seconds=n)
                elif "分钟" in text:
                    delta = timedelta(minutes=n)
                elif "小时" in text:
                    delta = timedelta(hours=n)
                elif "天" in text:
                    delta = timedelta(days=n)
        if delta is not None:
            return (observed_at - delta).isoformat(timespec="seconds"), "relative_approximate"

    return None, "unknown"


def build_payloads(account_id: int, observed_at: datetime) -> list[dict]:
    host = resolve_render_host()
    tree = build_tree(host["control"])
    shop_name = host["shop_title"].replace("[商家]", "").strip()
    messages = extract_messages(tree, shop_name=shop_name)

    # 会话键与客户键必须**按当前会话的客户**派生，不能只用店铺名。
    # 只用店铺名会让所有客户共用同一个 key：指纹里含 conversation_key，
    # 于是不同客户在相同时刻发的相同内容会算出同一个指纹，被误判为重复而丢消息；
    # 后端 findOrCreateConversation 也是按 (channel, account_id, user_id) 分会话的，
    # platformCustomerId 送错就会串台。
    conversations = extract_conversation_list(tree)
    customer_digest = ""
    if conversations:
        customer_digest = conversations[0]["nickname_redacted"]["digest"]

    customer_key = digest12(f"{shop_name}|{customer_digest}")
    conv_key = digest12(f"{shop_name}|{customer_digest}|current")

    assign_occurrences(messages)
    for msg in messages:
        msg["fingerprint"] = make_fingerprint(msg, conv_key)

    payloads: list[dict] = []
    for msg in messages:
        content = ""  # 只用摘要占位，真实正文在 content_digest 里；此处由调用方回填
        iso, precision = compose_timestamp(msg["time_text"], observed_at)

        message_type = "text"
        placeholder_hit = ""
        for placeholder in MEDIA_PLACEHOLDERS:
            if msg["content_length"] <= len(placeholder) + 2:
                message_type = MEDIA_PLACEHOLDERS[placeholder]
                placeholder_hit = PLACEHOLDER_SEMANTICS[placeholder]
                break

        payload = {
            "accountId": account_id,
            "channel": CHANNEL,
            # channelMessageId 只能由本地指纹充当（界面不提供平台消息 ID）
            "channelMessageId": msg["fingerprint"][:64],
            "platformConversationId": conv_key,
            "platformCustomerId": customer_key,
            "userName": msg["sender_masked"],
            "messageType": message_type,
            "platformPayload": {
                "direction": msg["direction"],
                "directionBasis": msg["direction_basis"],
                "readState": msg["read_state"] or None,
                "timeText": msg["time_text"],
                "timePrecision": precision,
                "contentDigest": msg["content_digest"],
                "contentLength": msg["content_length"],
                "senderLabel": msg["sender_label"],
                "placeholder": placeholder_hit or None,
            },
        }
        # schema 要求：content 非空 或 media 非空，二者必须有其一
        if message_type == "text":
            # 真实正文在抓取端；这里用占位以满足 schema 的 minLength，
            # 正式实现应传真实 content。
            payload["content"] = f"<{msg['content_length']} chars, digest={msg['content_digest']}>"
        else:
            payload["media"] = [{"type": message_type}]
        if iso:
            payload["clientTimestamp"] = iso
        payloads.append(payload)
    return payloads


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--account-id", type=int, required=True)
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--out", default=os.path.join(OUT_DIR, "envelopes.json"))
    args = parser.parse_args()

    observed_at = datetime.now(timezone.utc).astimezone()
    payloads = build_payloads(args.account_id, observed_at)

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payloads, fh, ensure_ascii=False, indent=2)

    print(f"观测时刻: {observed_at.isoformat(timespec='seconds')}")
    print(f"生成 {len(payloads)} 条 message.inbound 负载 -> {args.out}")
    print()
    for p in payloads:
        ts = p.get("clientTimestamp", "-")
        extra = f" media={p['media']}" if "media" in p else ""
        print(f"  type={p['messageType']:<8} ts={ts:<26} "
              f"prec={p['platformPayload']['timePrecision']:<20} "
              f"dir={p['platformPayload']['direction']}{extra}")
    print()
    print("接着运行校验：")
    print(f"  node validate_envelope.js ../rag-server/src/modules/desktop-bridge/bridgeProtocol.js "
          f"{os.path.basename(args.out)} {args.node_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
