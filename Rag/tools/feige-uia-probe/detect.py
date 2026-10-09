#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""飞鸽本地账号检测：向 stdout 输出单行 JSON，供后端「一键检测建号」调用。

设计要点
--------
- **单行 JSON 输出**：后端用 execFile 捕获 stdout 直接 JSON.parse，不做文本解析。
- **冷启动预热**：Chromium 首次启用无障碍树是异步的，刚附加时会读到不完整的树
  （实测 525 节点/1 条消息 → 预热后 670 节点/6 条消息）。这里等「连续两次读取
  节点数一致」才返回，避免把残缺数据当成账号信息报上去。
- **结构化失败**：不抛裸异常。退出码区分失败类型，同时仍输出一行 JSON，
  便于后端给出可读错误而不是 500。
- **只读**：仅 UIA 读取 + Win32 查询，不点击、不输入、不发送、不触碰输入框。

退出码
------
  0  成功
  3  未找到飞鸽/抖店客户端（未运行）
  4  预热超时（树一直不稳定）
  5  缺少依赖（uiautomation 未安装）

用法
----
  python detect.py            # 输出一行 JSON
  python detect.py --pretty   # 缩进输出，便于人工查看
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import socket
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

EXIT_OK = 0
EXIT_NO_CLIENT = 3
EXIT_WARMUP_TIMEOUT = 4
EXIT_NO_DEPENDENCY = 5

ADAPTER_ID = "doudian.feige"
CLIENT_PROCESS_HINTS = ("doudian.exe", "feige.exe")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def fail(code: int, reason: str, detail: str = "", extra: dict | None = None) -> int:
    payload = {
        "ok": False,
        "error": {"code": code, "reason": reason, "detail": detail},
        "detectedAt": now_iso(),
    }
    if extra:
        payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False))
    return code


def machine_fingerprint() -> str:
    """稳定的本机标识，用于桥接节点登记。只读系统信息，不读凭据。"""
    parts = [platform.node() or "", platform.machine() or ""]

    # Windows 的 MachineGuid 比主机名稳定（主机名可能被改）
    try:
        import winreg  # type: ignore

        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Cryptography",
            0,
            winreg.KEY_READ | winreg.KEY_WOW64_64KEY,
        ) as key:
            guid, _ = winreg.QueryValueEx(key, "MachineGuid")
            if guid:
                parts.append(str(guid))
    except Exception:
        pass

    if len(parts) < 3:
        # 回落：MAC 地址（只读网卡信息）
        try:
            import uuid

            parts.append(str(uuid.getnode()))
        except Exception:
            pass

    raw = "|".join(p for p in parts if p)
    import hashlib

    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def build_detection(warmup_seconds: float) -> dict:
    """附加 UIA 并读取账号信息。返回检测结果 dict。"""
    from feige_extract import (  # 延迟导入，便于统一处理依赖缺失
        build_tree,
        descendants,
        extract_agent_status,
        extract_conversation_list,
        resolve_render_host,
    )

    try:
        host = resolve_render_host()
    except SystemExit as exc:
        return {"__exit": EXIT_NO_CLIENT, "reason": "未找到飞鸽/抖店客户端窗口",
                "detail": str(exc)}

    control = host["control"]

    def tree_size() -> tuple[int, int]:
        tree = build_tree(control)
        nodes = list(descendants(tree))
        return len(nodes), sum(1 for n in nodes if n["name"])

    # 冷启动预热：等连续两次节点数一致
    deadline = time.monotonic() + warmup_seconds
    previous = None
    stable = False
    samples = 0
    while time.monotonic() < deadline:
        size = tree_size()
        samples += 1
        if previous is not None and size == previous:
            stable = True
            break
        previous = size
        time.sleep(0.5)

    if not stable and samples < 2:
        return {"__exit": EXIT_WARMUP_TIMEOUT, "reason": "元素树预热超时",
                "detail": f"{samples} 次采样内未稳定"}

    tree = build_tree(control)

    # 店铺名（窗口标题形如 [商家]xxx）
    title = host.get("shop_title", "") or ""
    shop_name = title.replace("[商家]", "").strip()

    status = extract_agent_status(tree)
    conversations = extract_conversation_list(tree)
    unread = sum(1 for c in conversations if c["has_unread"])

    return {
        "__exit": EXIT_OK,
        "ok": True,
        "shopName": shop_name,
        "agentStatus": status.get("text", "") if status.get("found") else "",
        "conversationCount": len(conversations),
        "unreadCount": unread,
        "clientProcess": CLIENT_PROCESS_HINTS[0],
        "windowHandle": host.get("main_hwnd"),
        "renderHostHandle": host.get("render_host_hwnd"),
        "adapterId": ADAPTER_ID,
        "machineFingerprint": machine_fingerprint(),
        "hostName": socket.gethostname(),
        "warmupStable": stable,
        "warmupSamples": samples,
        "detectedAt": now_iso(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="飞鸽本地账号检测（只读）")
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--warmup-seconds", type=float, default=25.0,
                        help="等待元素树稳定的最长时间")
    args = parser.parse_args()

    try:
        import uiautomation  # noqa: F401
    except ImportError as exc:
        return fail(EXIT_NO_DEPENDENCY, "缺少依赖 uiautomation",
                    f"{exc}；安装：python -m pip install uiautomation")

    try:
        result = build_detection(args.warmup_seconds)
    except Exception as exc:  # noqa: BLE001
        return fail(EXIT_WARMUP_TIMEOUT, "检测过程异常", f"{type(exc).__name__}: {exc}")

    code = result.pop("__exit", EXIT_OK)
    if code != EXIT_OK:
        return fail(code, result.get("reason", "检测失败"), result.get("detail", ""))

    if not result.get("shopName"):
        return fail(EXIT_NO_CLIENT, "已找到客户端但读不到店铺名",
                    "账号名称为空，无法建档；请确认飞鸽已登录且主窗口未被最小化")

    print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
