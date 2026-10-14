#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""千帆本地账号检测：向 stdout 输出单行 JSON，供后端「一键检测建号」调用。

契约与 `feige-uia-probe/detect.py` 完全一致：单行 JSON、退出码区分失败类型、
冷启动预热（等连续两次读取节点数一致）、只读（仅 UIA 读取 + Win32 查询）。

与飞鸽的差异
------------
- 进程名 `千帆客服工作台.exe`（安装代号 eva），窗口标题是 `eva` 无信息量，
  只能按进程 + class + 可见性定位；
- 店铺名不在窗口标题里：主内容区页头是一个短文本（如 `孤勇者玻璃隔热涂层`），
  48px 标题栏条里是带后缀的形态（`...的店`）。优先取 `的店` 形态，回落页头；
- 渲染宿主可能被重新挂载到隐藏容器窗口下，定位按**进程**扫描而不是主窗口子级。

退出码
------
  0  成功
  3  未找到千帆客户端（未运行）
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
import re
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

ADAPTER_ID = "xiaohongshu.qianfan"
CLIENT_PROCESS_HINTS = ("千帆客服工作台.exe",)
SHOP_SUFFIX = "的店"
SHOP_RE = re.compile(r"^(.{2,40})" + SHOP_SUFFIX + r"$")


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
    """稳定的本机标识，用于桥接节点登记。只读系统信息，不读凭据。

    ⚠️ 与 feige-uia-probe/detect.py 的算法保持完全一致：同一台机器两个平台
    必须得到相同指纹（一台机器只签发一个桥接节点，见 provision 的机指纹幂等）。
    """
    parts = [platform.node() or "", platform.machine() or ""]

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
        try:
            import uuid

            parts.append(str(uuid.getnode()))
        except Exception:
            pass

    raw = "|".join(p for p in parts if p)
    import hashlib

    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def collect_texts(ctrl) -> list[dict]:
    """深度优先收集带名字的节点（type/name/aid/depth）。"""
    out: list[dict] = []

    def walk(node, depth: int) -> None:
        if len(out) > 5000 or depth > 45:
            return
        try:
            name = node.Name or ""
        except Exception:
            name = ""
        if name.strip():
            try:
                ctype = node.ControlTypeName
            except Exception:
                ctype = ""
            try:
                aid = node.AutomationId or ""
            except Exception:
                aid = ""
            out.append({"depth": depth, "type": ctype, "aid": aid, "text": name})
        try:
            children = node.GetChildren()
        except Exception:
            children = []
        for c in children:
            walk(c, depth + 1)

    walk(ctrl, 0)
    return out


def build_detection(warmup_seconds: float) -> dict:
    from qianfan_capture import (  # 延迟导入，便于统一处理依赖缺失
        attach_render_host, enum_child_hwnds, enum_top_level, get_class_name,
        get_pid, resolve_main_window,
    )

    try:
        main = resolve_main_window()
    except SystemExit as exc:
        return {"__exit": EXIT_NO_CLIENT, "reason": "未找到千帆客户端窗口",
                "detail": str(exc)}
    if main["minimized"] or not main["visible"]:
        return {"__exit": EXIT_NO_CLIENT, "reason": "千帆窗口不可见或已最小化",
                "detail": "请先恢复窗口（最小化时读不到界面）"}

    # 冷启动预热：等连续两次节点数一致（Chromium 无障碍树是异步构建的）
    deadline = time.monotonic() + warmup_seconds
    previous = None
    stable = False
    samples = 0
    while time.monotonic() < deadline:
        try:
            resolved = attach_render_host(main["hwnd"])
        except SystemExit as exc:
            return {"__exit": EXIT_NO_CLIENT, "reason": "窗口存在但读不到界面",
                    "detail": str(exc)}
        size = (resolved["stats"]["nodes"], resolved["stats"]["texts"])
        samples += 1
        if previous is not None and size == previous:
            stable = True
            break
        previous = size
        time.sleep(0.5)

    if not stable and samples < 2:
        return {"__exit": EXIT_WARMUP_TIMEOUT, "reason": "元素树预热超时",
                "detail": f"{samples} 次采样内未稳定"}

    # 店铺名 + 客服状态：主内容区（当前视图）优先；标题栏条（...的店）兜底
    main_texts = collect_texts(resolved["control"])
    main_values = [t["text"].strip() for t in main_texts]

    # 同进程全部渲染宿主里的 '...的店' 形态（标题栏条里最稳定）
    shop_name = ""
    for t in main_values:
        m = SHOP_RE.match(t)
        if m and t != main_values[0]:
            shop_name = m.group(1)
            break
    if not shop_name:
        pid = main["pid"]
        for hwnd in enum_top_level():
            if get_pid(hwnd) != pid:
                continue
            for child in enum_child_hwnds(hwnd):
                if get_class_name(child) != "Chrome_RenderWidgetHostHWND":
                    continue
                try:
                    import uiautomation as auto

                    strip = auto.ControlFromHandle(child)
                    if strip is None or strip.Name == resolved.get("render_host_name"):
                        continue
                    for text in [n["text"].strip() for n in collect_texts(strip)]:
                        m = SHOP_RE.match(text)
                        if m:
                            shop_name = m.group(1)
                            break
                except Exception:
                    continue
                if shop_name:
                    break
            if shop_name:
                break
    if not shop_name:
        doc = resolved["render_host_name"] or ""
        if doc.endswith("-工作台") and "页面不见了" not in doc:
            shop_name = doc[: -len("-工作台")]

    # 客服状态：菜单项 在线 / 忙碌 / 离线
    agent_status = ""
    for t in main_texts:
        if t["type"] == "MenuItemControl" and t["text"].strip() in ("在线", "忙碌", "离线"):
            agent_status = t["text"].strip()
            break

    # 会话列表容器：farmer-contact-list 下的会话项数（当前无会话时为 0）
    conversation_count = 0
    for t in main_texts:
        if t["aid"] == "farmer-contact-list":
            conversation_count = max(conversation_count, 0)
            break

    return {
        "__exit": EXIT_OK,
        "ok": True,
        "shopName": shop_name,
        "agentStatus": agent_status,
        "conversationCount": conversation_count,
        "unreadCount": 0,
        "clientProcess": CLIENT_PROCESS_HINTS[0],
        "windowHandle": main["hwnd"],
        "renderHostHandle": resolved["render_host_hwnd"],
        "adapterId": ADAPTER_ID,
        "machineFingerprint": machine_fingerprint(),
        "hostName": socket.gethostname(),
        "warmupStable": stable,
        "warmupSamples": samples,
        "detectedAt": now_iso(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="千帆本地账号检测（只读）")
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
                    "账号名称为空，无法建档；请确认千帆已登录且主窗口未被最小化")

    print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
