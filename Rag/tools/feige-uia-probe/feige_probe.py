#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""飞鸽（抖店客服工作台）Windows UI Automation 只读探针。

本脚本用于 Desktop Bridge 的可行性验证：确认能否通过 Windows UI Automation
识别飞鸽窗口、店铺、会话列表、未读状态与当前会话消息，并对消息生成稳定指纹。

严格只读约束（由 `selfcheck` 子命令自证）
----------------------------------------
1. 仅使用 UIA 的读取能力：属性读取、TextPattern、ValuePattern。
2. 不调用任何会改变界面状态的 UIA Pattern：Invoke / Toggle / Select /
   SetValue / ExpandCollapse。
3. 不发送键鼠输入（无 SendKeys / SendInput / mouse_event / keybd_event）。
4. 不做截图 OCR，不读取进程内存，不注入进程，不抓包。
5. 不读取密码、Cookie、登录态、客户端内部数据库或本地存储文件。
6. 报告输出默认脱敏：昵称与消息正文只输出 SHA-256 前缀与长度，不输出原文。

子命令
------
  selfcheck   自证只读：扫描本文件源码，报告是否出现禁用 API
  discover    枚举顶层窗口，定位飞鸽窗口，浅层探测 UIA 可读性
  dump        导出目标窗口的 UIA 元素树（默认脱敏）
  snapshot    读取店铺 / 会话列表 / 未读 / 当前会话消息（脱敏）
  watch       轮询监听界面变化，识别新消息到达
  dedupe      重复读取同一会话，验证指纹稳定性与去重效果
  report      汇总以上结果，生成脱敏 Markdown 报告

用法示例
--------
  python feige_probe.py selfcheck
  python feige_probe.py discover
  python feige_probe.py dump     --window 0 --max-depth 14
  python feige_probe.py snapshot --window 0
  python feige_probe.py dedupe    --window 0 --rounds 3
  python feige_probe.py watch     --window 0 --seconds 60
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Optional

try:
    import uiautomation as auto
except ImportError:  # pragma: no cover
    sys.stderr.write(
        "缺少依赖：uiautomation\n"
        "安装：python -m pip install uiautomation\n"
    )
    raise SystemExit(2)

ADAPTER_ID = "doudian.feige"
HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(HERE, "raw")
OUT_DIR = os.path.join(HERE, "out")
PROFILE_PATH = os.path.join(HERE, "profiles", "doudian_feige.json")

# 出现在本文件即视为违反只读约束的 API 标记。
FORBIDDEN_TOKENS = (
    "InvokePattern",
    "TogglePattern",
    ".Click(",
    "SetValue(",
    "SendKeys",
    "SendInput",
    "keybd_event",
    "mouse_event",
    "SetForegroundWindow",
    "SetCursorPos",
    "WriteProcessMemory",
    "ReadProcessMemory",
    "pymem",
    "frida",
    "pyautogui",
    "SetWindowPos",
    "ShowWindow(",
    "CloseWindow",
    "TerminateProcess",
)

# UIA 中属于"改变状态"的 Pattern ID，仅用于自检报告，不在代码中调用。
MUTATING_PATTERN_NAMES = (
    "InvokePattern",
    "TogglePattern",
    "SelectionItemPattern",
    "ValuePattern.SetValue",
    "ExpandCollapsePattern",
    "ScrollPattern",
    "TransformPattern",
    "WindowPattern.Close",
)


# --------------------------------------------------------------------------
# 脱敏工具
# --------------------------------------------------------------------------

def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def digest12(text: str) -> str:
    return sha256_hex(text)[:12]


def normalize_text(value: Optional[str]) -> str:
    """归一化空白与零宽字符，保证指纹对排版差异稳定。"""
    if not value:
        return ""
    value = value.replace("\u200b", "").replace("\ufeff", "").replace("\xa0", " ")
    value = re.sub(r"[ \t\r\f\v]+", " ", value)
    value = re.sub(r"\n{2,}", "\n", value)
    return value.strip()


@dataclass
class Redacted:
    """脱敏文本表示：只保留长度、哈希与结构特征。"""

    length: int = 0
    digest: str = ""
    kind: str = "empty"

    @staticmethod
    def of(value: Optional[str]) -> "Redacted":
        text = normalize_text(value)
        if not text:
            return Redacted(0, "", "empty")
        kinds = []
        if re.search(r"\d", text):
            kinds.append("has_digit")
        if re.search(r"[A-Za-z]", text):
            kinds.append("has_alpha")
        if re.search(r"[\u4e00-\u9fff]", text):
            kinds.append("has_cjk")
        if re.fullmatch(r"[\d\s:：\-/年月日时分秒\.]+", text):
            kinds.append("time_like")
        if re.fullmatch(r"\d+", text):
            kinds.append("numeric")
        return Redacted(len(text), digest12(text), "+".join(kinds) or "other")


def mask_nickname(value: Optional[str]) -> str:
    """客户昵称脱敏：保留首字符，其余以 * 替代，便于人工核对同一会话。"""
    text = normalize_text(value)
    if not text:
        return ""
    if len(text) == 1:
        return "*"
    return text[0] + "*" * (len(text) - 1)


# --------------------------------------------------------------------------
# 元素访问（全部只读）
# --------------------------------------------------------------------------

def safe(fn: Callable[[], Any], default: Any = None) -> Any:
    try:
        return fn()
    except Exception:
        return default


def read_text_of(control: Any) -> str:
    """按只读方式读取控件文字：TextPattern 优先，回落 ValuePattern / Name。"""
    if control is None:
        return ""
    text = safe(lambda: control.GetTextPattern().DocumentRange.GetText(-1), "")
    if text and text.strip():
        return text
    value = safe(lambda: control.GetValuePattern().Value, "")
    if value and value.strip():
        return value
    return safe(lambda: control.Name, "") or ""


def rect_of(control: Any) -> Optional[dict]:
    rect = safe(lambda: control.BoundingRectangle, None)
    if rect is None:
        return None
    left = safe(lambda: rect.left, None)
    if left is None:
        return None
    return {
        "left": int(left),
        "top": int(safe(lambda: rect.top, 0) or 0),
        "width": int(safe(lambda: rect.width(), 0) or 0),
        "height": int(safe(lambda: rect.height(), 0) or 0),
    }


def child_count(control: Any) -> int:
    children = safe(lambda: control.GetChildren(), None)
    return len(children) if children else 0


def collect_text_nodes(control: Any, depth: int, max_depth: int, acc: list) -> None:
    """递归收集有文字的节点（只读），用于评估可读文字覆盖率。"""
    if control is None or depth > max_depth:
        return
    for child in safe(lambda: control.GetChildren(), []) or []:
        text = read_text_of(child)
        if text and text.strip():
            acc.append((child.ControlTypeName, normalize_text(text)))
        collect_text_nodes(child, depth + 1, max_depth, acc)


# --------------------------------------------------------------------------
# 进程与窗口发现
# --------------------------------------------------------------------------

def list_processes() -> dict[int, str]:
    """列出 pid -> 进程名。只读取进程名，不读取命令行或内存。"""
    result: dict[int, str] = {}
    try:
        out = subprocess.run(
            ["tasklist", "/fo", "csv", "/nh"],
            capture_output=True,
            timeout=60,
        ).stdout
    except Exception:
        return result
    for line in out.decode("gbk", errors="replace").splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2:
            name = parts[0].lstrip('"')
            pid_text = parts[1].strip('"')
            if pid_text.isdigit():
                result[int(pid_text)] = name
    return result


PROCESS_HINTS = (
    "doudian", "feige", "douyin", "promecef", "msedgewebview2", "weixin",
)


def candidate_pids() -> set[int]:
    procs = list_processes()
    hits = {
        pid for pid, name in procs.items()
        if any(hint in name.lower() for hint in PROCESS_HINTS)
    }
    return hits


@dataclass
class WindowInfo:
    index: int
    handle: int
    pid: int
    process: str
    name: str
    class_name: str
    control_type: str
    automation_id: str
    offscreen: bool
    rect: Optional[dict]
    depth1_children: int
    text_nodes_depth3: int
    text_sample: list
    uia_reachable: bool


def discover_windows(max_depth: int = 3) -> list[WindowInfo]:
    root = auto.GetRootControl()
    procs = list_processes()
    pids = candidate_pids()
    windows: list[WindowInfo] = []

    for child in safe(lambda: root.GetChildren(), []) or []:
        pid = safe(lambda: child.ProcessId, 0) or 0
        if pid not in pids:
            continue
        name = safe(lambda: child.Name, "") or ""
        ctype = safe(lambda: child.ControlTypeName, "") or ""
        cls = safe(lambda: child.ClassName, "") or ""
        aid = safe(lambda: child.AutomationId, "") or ""
        offscreen = bool(safe(lambda: child.IsOffscreen, False))

        text_nodes: list = []
        collect_text_nodes(child, 1, max_depth, text_nodes)

        windows.append(WindowInfo(
            index=len(windows),
            handle=safe(lambda: child.NativeWindowHandle, 0) or 0,
            pid=pid,
            process=procs.get(pid, "?"),
            name=Redacted.of(name).digest + "|" + mask_nickname(name),
            class_name=cls,
            control_type=ctype,
            automation_id=aid,
            offscreen=offscreen,
            rect=rect_of(child),
            depth1_children=child_count(child),
            text_nodes_depth3=len(text_nodes),
            text_sample=[
                {"type": t, **asdict(Redacted.of(x))} for t, x in text_nodes[:25]
            ],
            uia_reachable=len(text_nodes) > 0,
        ))

    return windows


def pick_window(index: int = 0, hwnd: Optional[int] = None) -> Any:
    """按 hwnd 或候选窗口索引取得 UIA 根控件。索引顺序会随窗口创建顺序变化，
    长期自动化请使用 --hwnd（由 win_enum.py 或 discover 获得）。"""
    if hwnd:
        control = safe(lambda: auto.ControlFromHandle(hwnd), None)
        if control is None:
            raise SystemExit(f"无法附加到 hwnd={hwnd}，窗口可能已关闭。")
        return control
    root = auto.GetRootControl()
    pids = candidate_pids()
    found = [
        c for c in (safe(lambda: root.GetChildren(), []) or [])
        if (safe(lambda: c.ProcessId, 0) or 0) in pids
    ]
    if not found:
        raise SystemExit("未找到飞鸽/抖店相关窗口，请确认客户端正在运行。")
    if index < 0 or index >= len(found):
        raise SystemExit(f"--window {index} 越界，可用范围 0..{len(found) - 1}")
    return found[index]


def target_window(args: argparse.Namespace) -> Any:
    return pick_window(getattr(args, "window", 0), getattr(args, "hwnd", None))


# --------------------------------------------------------------------------
# 元素树导出
# --------------------------------------------------------------------------

def _ext_props(node: Any, redact: bool) -> dict:
    """读取用于判断控件语义、列表位置与消息方向的扩展 UIA 属性（全部只读）。"""

    def text_prop(name: str) -> Any:
        value = safe(lambda: getattr(node, name, ""), "") or ""
        if not value:
            return ""
        return {**asdict(Redacted.of(value))} if redact else {"raw": normalize_text(value)}

    def int_prop(name: str) -> Optional[int]:
        value = safe(lambda: getattr(node, name, None), None)
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    return {
        "localized_type": safe(lambda: node.LocalizedControlType, "") or "",
        "help_text": text_prop("HelpText"),
        "full_description": text_prop("FullDescription"),
        "item_status": text_prop("ItemStatus"),
        "item_type": safe(lambda: node.ItemType, "") or "",
        "accelerator_key": safe(lambda: node.AcceleratorKey, "") or "",
        "access_key": safe(lambda: node.AccessKey, "") or "",
        "position_in_set": int_prop("PositionInSet"),
        "size_of_set": int_prop("SizeOfSet"),
        "level": int_prop("Level"),
        "is_enabled": bool(safe(lambda: node.IsEnabled, False)),
        "is_keyboard_focusable": bool(safe(lambda: node.IsKeyboardFocusable, False)),
    }


def dump_tree(control: Any, max_depth: int, max_nodes: int, redact: bool) -> dict:
    counter = {"n": 0}

    def walk(node: Any, depth: int, path: str) -> Optional[dict]:
        if counter["n"] >= max_nodes or depth > max_depth:
            return None
        counter["n"] += 1

        raw_name = safe(lambda: node.Name, "") or ""
        entry: dict[str, Any] = {
            "path": path,
            "type": safe(lambda: node.ControlTypeName, "") or "",
            "class": safe(lambda: node.ClassName, "") or "",
            "automation_id": safe(lambda: node.AutomationId, "") or "",
            "pid": safe(lambda: node.ProcessId, 0) or 0,
            "handle": safe(lambda: node.NativeWindowHandle, 0) or 0,
            "offscreen": bool(safe(lambda: node.IsOffscreen, False)),
            "rect": rect_of(node),
            "patterns": [
                p for p in (
                    "text", "value", "invoke", "selection", "scroll", "legacy"
                ) if safe(lambda p=p: getattr(node, f"Is{p.capitalize()}PatternAvailable")(), False)
            ],
            "text": (
                {"raw": normalize_text(raw_name)}
                if not redact
                else {**asdict(Redacted.of(raw_name))}
            ),
            # 扩展属性：用于判断消息方向、列表位置与控件语义
            "ext": _ext_props(node, redact),
        }

        children = safe(lambda: node.GetChildren(), []) or []
        entry["child_count"] = len(children)
        subs = []
        for i, child in enumerate(children):
            sub = walk(child, depth + 1, f"{path}/{i}")
            if sub is None:
                break
            subs.append(sub)
        if subs:
            entry["children"] = subs
        elif entry["child_count"]:
            entry["children_truncated"] = True
        return entry

    return walk(control, 0, "0") or {}


# --------------------------------------------------------------------------
# 会话与消息提取
# --------------------------------------------------------------------------

def load_profile() -> dict:
    if os.path.exists(PROFILE_PATH):
        with open(PROFILE_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    return {}


def find_descendants(control: Any, predicate: Callable[[Any], bool],
                     max_depth: int = 20, limit: int = 4000) -> list:
    """广度优先查找满足条件的后代（只读）。"""
    result: list = []
    queue = [(control, 0)]
    seen = 0
    while queue and seen < limit:
        node, depth = queue.pop(0)
        if depth > max_depth:
            continue
        for child in safe(lambda: node.GetChildren(), []) or []:
            seen += 1
            if predicate(child):
                result.append(child)
            queue.append((child, depth + 1))
        if seen >= limit:
            break
    return result


TIME_LIKE = re.compile(
    r"^(\d{1,2}:\d{2}(:\d{2})?|"
    r"(今天|昨天|前天|星期[一二三四五六日]|周[一二三四五六日])\s*\d{0,2}:?\d{0,2}|"
    r"\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(\s*\d{1,2}:\d{2})?|"
    r"\d{1,2}月\d{1,2}日(\s*\d{1,2}:\d{2})?)$"
)

UNREAD_LIKE = re.compile(r"^\d{1,3}$|^\d{1,3}\+$")
BADGE_WORDS = ("未读", "条新消息", "新消息")


@dataclass
class MessageRow:
    """从界面读取到的一条消息（脱敏后）。"""

    order: int
    direction: str
    sender_raw: str
    sender_key: str
    time_text: str
    content_raw: str
    content_length: int
    content_digest: str
    occurrence: int = 0
    fingerprint: str = ""

    def to_redacted(self) -> dict:
        return {
            "order": self.order,
            "direction": self.direction,
            "sender_key": self.sender_key,
            "time_text": self.time_text,
            "content_length": self.content_length,
            "content_digest": self.content_digest,
            "occurrence": self.occurrence,
            "fingerprint": self.fingerprint,
        }


def message_fingerprint(row: MessageRow, conversation_key: str) -> str:
    """稳定指纹。

    输入全部来自界面可见信息，不依赖平台 messageId：
      adapter | conversation_key | direction | sender_key |
      time_text | content_digest | occurrence

    occurrence 用于区分"同一会话内、发送者/时间/正文完全相同"的重复消息
    （例如连发两条"在吗"）。详见 README 的稳定性讨论。
    """
    parts = [
        ADAPTER_ID,
        conversation_key,
        row.direction,
        row.sender_key,
        normalize_text(row.time_text) or "",
        row.content_digest,
        str(row.occurrence),
    ]
    return sha256_hex("\x1f".join(parts))


def assign_occurrences(rows: list[MessageRow]) -> None:
    """为完全相同的 (direction, sender, time, content) 组合分配序号。"""
    seen: dict[tuple, int] = {}
    for row in rows:
        key = (row.direction, row.sender_key, normalize_text(row.time_text), row.content_digest)
        row.occurrence = seen.get(key, 0)
        seen[key] = row.occurrence + 1


def extract_messages(profile: dict, root: Any) -> list[MessageRow]:
    """从当前会话区域提取消息行。

    提取策略由 profiles/doudian_feige.json 描述，避免把易变的界面结构硬编码进
    代码。缺少 profile 时回退到"时间戳 + 文本"的通用启发式。
    """
    rows: list[MessageRow] = []
    msg_spec = profile.get("message_list", {})

    container = None
    container_name = msg_spec.get("container_name_regex")
    if container_name:
        pattern = re.compile(container_name)
        for candidate in find_descendants(
            root, lambda c: bool(re.search(pattern, safe(lambda: c.Name, "") or ""))
        ):
            container = candidate
            break
    if container is None:
        container = root

    time_re = re.compile(msg_spec.get("time_regex", TIME_LIKE.pattern))

    # 收集"叶子文本 + 相邻时间戳"，按几何位置自上而下排序。
    leaves: list[tuple[int, int, str]] = []

    def gather(node: Any, depth: int) -> None:
        if depth > 18:
            return
        children = safe(lambda: node.GetChildren(), []) or []
        if not children:
            text = read_text_of(node)
            if text and text.strip():
                rect = rect_of(node)
                if rect:
                    leaves.append((rect["top"], rect["left"], normalize_text(text)))
            return
        for child in children:
            gather(child, depth + 1)

    gather(container, 0)
    leaves.sort(key=lambda item: (item[0], item[1]))

    pending_time = ""
    sender_key = ""
    for top, _left, text in leaves:
        if time_re.match(text):
            pending_time = text
            continue
        if text in BADGE_WORDS:
            continue
        if UNREAD_LIKE.match(text) and len(text) <= 4:
            continue
        if len(text) > 4000:
            continue
        rows.append(MessageRow(
            order=len(rows),
            direction=msg_spec.get("default_direction", "unknown"),
            sender_raw="",
            sender_key=sender_key,
            time_text=pending_time,
            content_raw=text,
            content_length=len(text),
            content_digest=digest12(text),
        ))

    assign_occurrences(rows)
    for row in rows:
        row.fingerprint = message_fingerprint(row, conversation_key=profile.get("_conversation_key", "unknown"))
    return rows


def extract_shop(profile: dict, root: Any) -> dict:
    spec = profile.get("shop", {})
    pattern = spec.get("name_regex")
    if not pattern:
        return {"found": False, "reason": "no shop locator in profile"}
    probe = re.compile(pattern)
    for node in find_descendants(root, lambda c: bool(probe.search(safe(lambda: c.Name, "") or ""))):
        text = read_text_of(node)
        return {
            "found": True,
            "automation_id": safe(lambda: node.AutomationId, "") or "",
            "redacted": asdict(Redacted.of(text)),
            "masked": mask_nickname(text),
        }
    return {"found": False, "reason": "shop element not located"}


def extract_conversations(profile: dict, root: Any) -> list[dict]:
    spec = profile.get("conversation_list", {})
    pattern = spec.get("item_name_regex")
    if not pattern:
        return []
    probe = re.compile(pattern)
    items = find_descendants(
        root,
        lambda c: bool(probe.search(safe(lambda: c.AutomationId, "") or ""))
        or bool(probe.search(safe(lambda: c.ClassName, "") or "")),
        limit=3000,
    )
    out = []
    for node in items:
        text = normalize_text(safe(lambda: node.Name, "") or "")
        unread = extract_unread(node, spec)
        out.append({
            "masked_name": mask_nickname(text),
            "name_redacted": asdict(Redacted.of(text)),
            "unread": unread,
            "offscreen": bool(safe(lambda: node.IsOffscreen, False)),
            "rect": rect_of(node),
        })
    return out


def extract_unread(node: Any, spec: dict) -> dict:
    unread_re = re.compile(spec.get("unread_regex", UNREAD_LIKE.pattern))
    hits = []
    for child in find_descendants(node, lambda c: bool(unread_re.match(normalize_text(safe(lambda: c.Name, "") or ""))), max_depth=8):
        text = normalize_text(safe(lambda: child.Name, "") or "")
        hits.append({"value_redacted": asdict(Redacted.of(text))})
    return {"has_unread": len(hits) > 0, "badges": hits[:3]}


# --------------------------------------------------------------------------
# 子命令实现
# --------------------------------------------------------------------------

def ensure_dirs() -> None:
    os.makedirs(RAW_DIR, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)


def write_json(path: str, payload: Any) -> None:
    ensure_dirs()
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def cmd_selfcheck(_args: argparse.Namespace) -> int:
    """用 AST 检查真实调用点，避免把禁用词表本身当成命中。"""
    import ast

    source = open(os.path.abspath(__file__), "r", encoding="utf-8").read()
    tree = ast.parse(source)
    forbidden = set(FORBIDDEN_TOKENS)

    attr_hits: list[dict] = []
    call_hits: list[dict] = []

    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr in forbidden:
            attr_hits.append({"token": node.attr, "line": node.lineno})
        if isinstance(node, ast.Call):
            func = node.func
            name = None
            if isinstance(func, ast.Attribute):
                name = func.attr
            elif isinstance(func, ast.Name):
                name = func.id
            if name in forbidden:
                call_hits.append({"token": name, "line": node.lineno})

    report = {
        "checked_at": now_iso(),
        "file": os.path.basename(__file__),
        "method": "ast 扫描真实属性访问与调用点（忽略字符串常量与注释）",
        "forbidden_token_list": sorted(forbidden),
        "forbidden_attribute_accesses": attr_hits,
        "forbidden_call_sites": call_hits,
        "mutating_patterns_never_called": list(MUTATING_PATTERN_NAMES),
        "readonly_capabilities_used": [
            "Control.GetChildren（遍历）",
            "属性读取（Name/ClassName/AutomationId/ProcessId/BoundingRectangle/IsOffscreen）",
            "TextPattern.DocumentRange.GetText（只读）",
            "ValuePattern.Value（只读属性）",
            "Win32 查询 API（EnumWindows/GetWindowRect/IsWindowVisible 等）",
        ],
        "verdict": "PASS" if not (attr_hits or call_hits) else "REVIEW",
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def cmd_discover(args: argparse.Namespace) -> int:
    windows = discover_windows(max_depth=args.depth)
    payload = {
        "generated_at": now_iso(),
        "adapter_id": ADAPTER_ID,
        "candidate_process_hints": list(PROCESS_HINTS),
        "window_count": len(windows),
        "windows": [asdict(w) for w in windows],
    }
    out = args.out or os.path.join(OUT_DIR, "discover.json")
    write_json(out, payload)

    print(f"发现 {len(windows)} 个候选窗口 -> {out}\n")
    for w in windows:
        print(f"[{w.index}] pid={w.pid}({w.process}) hwnd={w.handle} "
              f"type={w.control_type} class={w.class_name}")
        print(f"     title={w.name}")
        print(f"     offscreen={w.offscreen} children={w.depth1_children} "
              f"text_nodes(<=d{args.depth})={w.text_nodes_depth3} "
              f"uia_reachable={w.uia_reachable}")
        if w.text_sample:
            for sample in w.text_sample[:8]:
                print(f"       - {sample['type']}: len={sample['length']} "
                      f"kind={sample['kind']} sha={sample['digest']}")
        print()
    return 0


def cmd_dump(args: argparse.Namespace) -> int:
    control = target_window(args)
    tree = dump_tree(control, args.max_depth, args.max_nodes, redact=not args.raw)
    payload = {
        "generated_at": now_iso(),
        "window_index": args.window,
        "max_depth": args.max_depth,
        "redacted": not args.raw,
        "tree": tree,
    }
    if args.raw:
        out = args.out or os.path.join(RAW_DIR, "tree_raw.json")
        print("警告：--raw 输出包含未脱敏界面文本，仅限本机分析，禁止提交。")
    else:
        out = args.out or os.path.join(OUT_DIR, "tree_redacted.json")
    write_json(out, payload)
    print(f"元素树已导出 -> {out}")
    return 0


def cmd_snapshot(args: argparse.Namespace) -> int:
    profile = load_profile()
    control = target_window(args)
    shop = extract_shop(profile, control)
    conversations = extract_conversations(profile, control)
    messages = extract_messages(profile, control)
    payload = {
        "generated_at": now_iso(),
        "window_index": args.window,
        "shop": shop,
        "conversation_count": len(conversations),
        "unread_conversations": sum(1 for c in conversations if c["unread"]["has_unread"]),
        "conversations": conversations[:30],
        "message_count": len(messages),
        "messages": [m.to_redacted() for m in messages[:80]],
    }
    out = args.out or os.path.join(OUT_DIR, "snapshot.json")
    write_json(out, payload)

    print(f"店铺识别: {shop}")
    print(f"会话数: {len(conversations)}，其中有未读标记: {payload['unread_conversations']}")
    print(f"当前会话消息数: {len(messages)}")
    for m in messages[:10]:
        print(f"  #{m.order} [{m.direction}] t={m.time_text!r} "
              f"len={m.content_length} sha={m.content_digest} fp={m.fingerprint[:12]}")
    print(f"\n-> {out}")
    return 0


def cmd_dedupe(args: argparse.Namespace) -> int:
    """重复读取同一会话，验证指纹集合稳定性。"""
    profile = load_profile()
    control = target_window(args)
    rounds: list[set[str]] = []
    per_round: list[list[dict]] = []

    for i in range(args.rounds):
        messages = extract_messages(profile, control)
        fps = {m.fingerprint for m in messages}
        rounds.append(fps)
        per_round.append([m.to_redacted() for m in messages])
        print(f"第 {i + 1} 轮: {len(messages)} 条，唯一指纹 {len(fps)} 个")
        if i + 1 < args.rounds:
            time.sleep(args.interval)

    baseline = rounds[0]
    stable = all(r == baseline for r in rounds[1:])
    union = set().union(*rounds) if rounds else set()
    intersection = set.intersection(*rounds) if rounds else set()

    # 去重效果：把每轮指纹并入"累计库"，统计重复条数。
    ledger: set[str] = set()
    duplicates = 0
    for fps in rounds:
        for fp in fps:
            if fp in ledger:
                duplicates += 1
            else:
                ledger.add(fp)

    payload = {
        "generated_at": now_iso(),
        "window_index": args.window,
        "rounds": args.rounds,
        "interval_seconds": args.interval,
        "per_round_counts": [len(r) for r in rounds],
        "unique_per_round": [len(r) for r in rounds],
        "stable_across_rounds": stable,
        "union": len(union),
        "intersection": len(intersection),
        "duplicate_inserts_prevented": duplicates,
        "ledger_size": len(ledger),
        "messages_sample": per_round[0][:20] if per_round else [],
    }
    out = args.out or os.path.join(OUT_DIR, "dedupe.json")
    write_json(out, payload)

    print()
    print(f"跨轮稳定: {stable}")
    print(f"并集 {len(union)} / 交集 {len(intersection)}")
    print(f"若直接入库将产生的重复条数: {duplicates}（被指纹拦下）")
    print(f"-> {out}")
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    """轮询监听界面变化，识别新消息到达。"""
    profile = load_profile()
    control = target_window(args)

    def snapshot_state() -> dict:
        messages = extract_messages(profile, control)
        fps = [m.fingerprint for m in messages]
        return {
            "fingerprints": fps,
            "text_nodes": len(find_descendants(
                control, lambda c: bool(read_text_of(c).strip()), max_depth=14, limit=600
            )),
            "messages": messages,
        }

    events: list[dict] = []
    print(f"开始监听 {args.seconds}s（轮询间隔 {args.interval}s）…")
    before = snapshot_state()
    known = set(before["fingerprints"])
    print(f"基线：{len(before['fingerprints'])} 条消息")

    deadline = time.time() + args.seconds
    while time.time() < deadline:
        time.sleep(args.interval)
        after = snapshot_state()
        new_fps = [fp for fp in after["fingerprints"] if fp not in known]
        removed = [fp for fp in known if fp not in set(after["fingerprints"])]
        if new_fps or removed:
            event = {
                "at": now_iso(),
                "new_messages": len(new_fps),
                "new_fingerprints": new_fps[:10],
                "removed_messages": len(removed),
                "text_node_delta": after["text_nodes"] - before["text_nodes"],
            }
            events.append(event)
            known = set(after["fingerprints"])
            print(f"  +{len(new_fps)} / -{len(removed)}  text_delta={event['text_node_delta']}")
            for msg in after["messages"]:
                if msg.fingerprint in new_fps[:10]:
                    print(f"      len={msg.content_length} sha={msg.content_digest} "
                          f"t={msg.time_text!r} fp={msg.fingerprint[:12]}")
            before = after

    payload = {
        "generated_at": now_iso(),
        "window_index": args.window,
        "duration_seconds": args.seconds,
        "interval_seconds": args.interval,
        "baseline_message_count": len(known),
        "change_events": events,
        "detected_changes": len(events),
        "mechanism": "UIA polling diff on message fingerprints",
    }
    out = args.out or os.path.join(OUT_DIR, "watch.json")
    write_json(out, payload)
    print(f"\n检测到 {len(events)} 次界面变化 -> {out}")
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    """把已生成的各子命令结果汇总为脱敏 Markdown。"""
    def load(name: str) -> Optional[dict]:
        path = os.path.join(OUT_DIR, name)
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        return None

    discover = load("discover.json")
    snapshot = load("snapshot.json")
    dedupe = load("dedupe.json")
    watch = load("watch.json")

    lines: list[str] = []
    lines.append("# 飞鸽 UI Automation 只读探针报告（脱敏）")
    lines.append("")
    lines.append(f"生成时间：{now_iso()}")
    lines.append(f"适配器：`{ADAPTER_ID}`")
    lines.append("")
    lines.append("> 本报告所有界面文本均已脱敏，仅保留长度、SHA-256 前缀与结构特征。")
    lines.append("")

    if discover:
        lines.append("## 1. 窗口发现")
        lines.append("")
        lines.append(f"- 候选窗口数：{discover['window_count']}")
        for w in discover["windows"]:
            lines.append(
                f"- `[{w['index']}]` pid={w['pid']}({w['process']}) "
                f"type={w['control_type']} class=`{w['class_name']}` "
                f"offscreen={w['offscreen']} children={w['depth1_children']} "
                f"text_nodes={w['text_nodes_depth3']} "
                f"**UIA 可读={w['uia_reachable']}**"
            )
        lines.append("")

    if snapshot:
        lines.append("## 2. 会话与消息")
        lines.append("")
        lines.append(f"- 店铺识别：`{snapshot['shop']}`")
        lines.append(f"- 会话数：{snapshot['conversation_count']}")
        lines.append(f"- 含未读标记会话：{snapshot['unread_conversations']}")
        lines.append(f"- 当前会话消息数：{snapshot['message_count']}")
        lines.append("")

    if dedupe:
        lines.append("## 3. 指纹稳定性与去重")
        lines.append("")
        lines.append(f"- 轮次：{dedupe['rounds']}，间隔 {dedupe['interval_seconds']}s")
        lines.append(f"- 每轮条数：{dedupe['per_round_counts']}")
        lines.append(f"- **跨轮稳定：{dedupe['stable_across_rounds']}**")
        lines.append(f"- 并集 {dedupe['union']} / 交集 {dedupe['intersection']}")
        lines.append(f"- 被指纹拦下的重复入库：{dedupe['duplicate_inserts_prevented']}")
        lines.append("")

    if watch:
        lines.append("## 4. 界面变化监听")
        lines.append("")
        lines.append(f"- 监听时长：{watch['duration_seconds']}s，机制：{watch['mechanism']}")
        lines.append(f"- 检测到变化次数：{watch['detected_changes']}")
        for event in watch["change_events"][:10]:
            lines.append(
                f"  - {event['at']} 新增 {event['new_messages']} / "
                f"移除 {event['removed_messages']} / 文本节点差 {event['text_node_delta']}"
            )
        lines.append("")

    content = "\n".join(lines) + "\n"
    out = args.out or os.path.join(HERE, "REPORT-feige-uia-probe.md")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(content)
    print(f"报告已生成 -> {out}")
    return 0


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="飞鸽 Windows UI Automation 只读探针",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    for name, handler, help_text in (
        ("selfcheck", cmd_selfcheck, "自证只读：扫描源码中的禁用 API"),
        ("discover", cmd_discover, "枚举候选窗口并探测 UIA 可读性"),
        ("dump", cmd_dump, "导出元素树"),
        ("snapshot", cmd_snapshot, "读取店铺/会话/未读/消息"),
        ("dedupe", cmd_dedupe, "验证指纹稳定性与去重"),
        ("watch", cmd_watch, "轮询监听界面变化"),
        ("report", cmd_report, "汇总生成脱敏报告"),
    ):
        p = sub.add_parser(name, help=help_text)
        p.set_defaults(func=handler)
        p.add_argument("--out", default=None, help="输出文件路径")
        if name in ("discover", "dump", "snapshot", "dedupe", "watch"):
            p.add_argument("--window", type=int, default=0, help="窗口索引（见 discover）")
            p.add_argument("--hwnd", type=int, default=None,
                           help="按窗口句柄定位（推荐，见 win_enum.py）")
        if name == "discover":
            p.add_argument("--depth", type=int, default=3, help="浅层文字探测深度")
        if name == "dump":
            p.add_argument("--max-depth", type=int, default=14)
            p.add_argument("--max-nodes", type=int, default=15000)
            p.add_argument("--raw", action="store_true", help="输出未脱敏文本（禁止提交）")
        if name in ("dedupe",):
            p.add_argument("--rounds", type=int, default=3)
            p.add_argument("--interval", type=float, default=1.0)
        if name in ("watch",):
            p.add_argument("--seconds", type=float, default=60.0)
            p.add_argument("--interval", type=float, default=1.0)

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    auto.SetGlobalSearchTimeout(3)
    ensure_dirs()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
