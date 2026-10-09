#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""飞鸽客服系统字段提取与指纹验证（只读）。

最重要的修复
------------
主窗口顶层（`Chrome_WidgetWin_1`）的 UIA 提供程序**不会**把内容链接进来，
从它遍历只能得到一条空的 PaneControl 链。必须附加到它的子窗口
`Chrome_RenderWidgetHostHWND`（Chromium 的 "Chrome Legacy Window"），
才能拿到完整元素树（实测 630 节点 / 168 文本节点）。

这不是遮挡问题：主窗口遮挡率降到 0.029 时，从顶层看仍然是空的。

结构要点
--------
- 外层 DocumentControl = 抖店工作台外壳
- `@@preheatContainer@@ > webview_0 > PaneControl > DocumentControl '飞鸽客服系统'`
  = 真正的飞鸽客服 UI（嵌套文档）
- 关键容器 aid：`chantListScrollArea`（会话列表）、`im-input-box`（输入框，禁止触碰）、
  `rc-tabs-0-tab-current`（当前会话）、`topbar-left-info`（当前客户）

指纹设计（相比浮窗版本的重要改进）
------------------------------------
消息区带的 `HH:MM:SS` 是**绝对时间**（如 `17:43:23`），不是浮窗的相对时间（`1小时`）。
因此指纹用绝对时间，天然规避了相对时间漂移问题。

只读：仅 UIA 读取，不点击、不输入、不发送、不触碰 im-input-box。
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any, Optional

import uiautomation as auto

from feige_probe import Redacted, digest12, mask_nickname, normalize_text, rect_of, safe, sha256_hex
from win_enum import EnumWindowsProc, get_class_name, get_window_text, user32

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")
ADAPTER_ID = "doudian.feige"

MAIN_TITLE_RE = re.compile(r"^\[商家\]")
ABS_TIME_RE = re.compile(r"^\d{1,2}:\d{2}(:\d{2})?$")
# 相对时间必须整体匹配，否则会把 "7天无理由退货" 这类保障标签里的 "7天" 误判成时间
REL_TIME_RE = re.compile(
    r"^(刚刚|昨天.*|\d+\s*(秒|分钟|小时|天|周|个月)(前|钟)?|"
    r"星期[一二三四五六日]|周[一二三四五六日])$"
)
READ_STATES = ("已读", "未读")
SENT_BY_HINTS = ("智能客服发送", "商家配置发送", "客服发送", "系统发送")
NOISE = {
    "头像", "关闭", "最小化", "最大化", "下箭头", "更多", "添加备注",
    "列表设置", "等待时长", "不分组", "以上为历史消息",
}
# 发送者标签：这些是角色名，不是消息正文
ROLE_LABELS = ("智能客服", "系统消息", "机器人接待中", "客服", "机器人")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# 渲染宿主解析（本脚本的核心修复）
# --------------------------------------------------------------------------

def enum_child_hwnds(parent: int) -> list[int]:
    out: list[int] = []

    def cb(hwnd, _lparam):
        out.append(int(hwnd))
        return True

    user32.EnumChildWindows(__import__("ctypes").wintypes.HWND(parent), EnumWindowsProc(cb), 0)
    return out


def find_main_window_hwnd() -> Optional[int]:
    hwnds: list[int] = []

    def collect(hwnd, _lparam):
        hwnds.append(int(hwnd))
        return True

    user32.EnumWindows(EnumWindowsProc(collect), 0)
    for hwnd in hwnds:
        if get_class_name(hwnd) != "Chrome_WidgetWin_1":
            continue
        if MAIN_TITLE_RE.search(get_window_text(hwnd)):
            return hwnd
    return None


def resolve_render_host() -> dict:
    """返回 {main_hwnd, render_host_hwnd, control, shop_title}。"""
    main = find_main_window_hwnd()
    if main is None:
        raise SystemExit("未找到主窗口（标题应以 [商家] 开头）")
    for child in enum_child_hwnds(main):
        if get_class_name(child) == "Chrome_RenderWidgetHostHWND":
            control = safe(lambda: auto.ControlFromHandle(child), None)
            if control is None:
                continue
            return {
                "main_hwnd": main,
                "render_host_hwnd": child,
                "control": control,
                "shop_title": get_window_text(main),
            }
    raise SystemExit("主窗口下未找到 Chrome_RenderWidgetHostHWND 子窗口")


# --------------------------------------------------------------------------
# 文档序遍历
# --------------------------------------------------------------------------

def ordered_leaves(control: Any, max_depth: int = 45, max_nodes: int = 30000) -> list[dict]:
    """按文档顺序收集叶子文本节点。文档顺序即消息的时间顺序。"""
    out: list[dict] = []
    counter = {"n": 0}

    def walk(node: Any, depth: int) -> None:
        if counter["n"] >= max_nodes or depth > max_depth:
            return
        counter["n"] += 1
        children = safe(lambda: node.GetChildren(), []) or []
        if not children:
            text = normalize_text(safe(lambda: node.Name, "") or "")
            if text:
                out.append({
                    "text": text,
                    "type": safe(lambda: node.ControlTypeName, "") or "",
                    "aid": safe(lambda: node.AutomationId, "") or "",
                    "depth": depth,
                    "rect": rect_of(node),
                    "offscreen": bool(safe(lambda: node.IsOffscreen, False)),
                })
            return
        for child in children:
            walk(child, depth + 1)

    walk(control, 0)
    return out


# --------------------------------------------------------------------------
# 字段提取
# --------------------------------------------------------------------------

def build_tree(control: Any, max_depth: int = 45, max_nodes: int = 30000) -> dict:
    """把 UIA 子树转成轻量 dict 树，供结构化提取使用。

    只保留结构分析需要的字段：控件类型、文本、几何、automation_id、是否离屏。
    未布局节点（rect 为 0x0）保留在树中——它们的内容可读，只是坐标不可用。
    """
    counter = {"n": 0}

    def walk(node: Any, depth: int) -> Optional[dict]:
        if counter["n"] >= max_nodes or depth > max_depth:
            return None
        counter["n"] += 1
        info: dict = {
            "type": safe(lambda: node.ControlTypeName, "") or "",
            "name": normalize_text(safe(lambda: node.Name, "") or ""),
            "aid": safe(lambda: node.AutomationId, "") or "",
            "rect": rect_of(node),
            "offscreen": bool(safe(lambda: node.IsOffscreen, False)),
            "children": [],
        }
        children = safe(lambda: node.GetChildren(), []) or []
        for child in children:
            sub = walk(child, depth + 1)
            if sub is not None:
                info["children"].append(sub)
        return info

    return walk(control, 0) or {}


def descendants(node: dict):
    """文档序（前序）遍历全部后代，含自身。"""
    yield node
    for child in node.get("children", []):
        yield from descendants(child)


def subtree_texts(node: dict) -> list[str]:
    return [n["name"] for n in descendants(node) if n["name"]]


def has_image_named(node: dict, name: str) -> bool:
    return any(n["type"] == "ImageControl" and n["name"] == name for n in descendants(node))


def count_image_named(node: dict, name: str) -> int:
    return sum(1 for n in descendants(node) if n["type"] == "ImageControl" and n["name"] == name)


def has_rect(node: dict) -> bool:
    rect = node.get("rect")
    return bool(rect and rect.get("width") and rect.get("height"))


TOPBAR_AID = "topbar-left-info"
TOPBAR_NOISE = ("添加备注",)


def current_customer(tree: dict, shop_name: str) -> Optional[dict]:
    """取"当前打开会话"的客户信息，**含未脱敏昵称**。

    昵称来源是顶栏 `topbar-left-info`（形如：昵称 + "添加备注"）。

    ⚠️ 不要用"会话列表项"启发式来取昵称 —— 实测踩过：
    `_is_conversation_item` 会把**聊天区的消息行**（头像 + 文本 + 时间）也认成会话项，
    于是把客户发的一条消息正文（"我会被晒黑吗"）当成了昵称入库。
    会话列表容器为空时更容易误匹配。顶栏是当前会话的权威来源，且与输入框占位符
    （"发送给 X，使用Enter 发送消息"）互相印证。

    返回 {rawName, nameDigest, customerKey, conversationKey}，取不到返回 None。
    """
    topbar = None
    for node in descendants(tree):
        if (node.get("aid") or "") == TOPBAR_AID:
            topbar = node
            break
    raw_name = ""
    if topbar is not None:
        for text in subtree_texts(topbar):
            cleaned = text.strip()
            if cleaned and cleaned not in TOPBAR_NOISE:
                raw_name = cleaned
                break
    if not raw_name:
        return None

    name_digest = digest12(normalize_text(raw_name))
    return {
        "rawName": raw_name,
        "nameDigest": name_digest,
        # 客户键：入站上报与发送校验都用它，必须与已入库的 conversations.user_id 一致
        "customerKey": digest12(f"{shop_name}|{name_digest}"),
        "conversationKey": digest12(f"{shop_name}|{name_digest}|current"),
    }


CONV_LIST_AID = "chantListScrollArea"


def conversation_list_readable(tree: dict) -> bool:
    """会话列表容器是否存在（可读）。

    为什么需要单独一个判断：`active_conversation_keys` 在"容器不存在"和
    "容器存在但没有会话"两种情况下都返回 []，但这两件事的含义完全相反——
    前者是**读不到**（不能据此归档，否则一次解析失败会清空所有会话），
    后者是**列表真的是空的**（会话该归档了）。

    实测场景：客户的会话倒计时结束后会从列表消失（容器里只剩"暂无会话中用户"），
    但界面仍停在那条会话上、顶栏还显示着它——只看顶栏永远等不到归档。
    """
    for node in descendants(tree):
        if (node.get("aid") or "") == CONV_LIST_AID:
            return True
    return False


def active_conversation_keys(tree: dict, shop_name: str) -> list:
    """当前会话列表里所有会话的客户键。

    ⚠️ **必须限定在会话列表容器 `chantListScrollArea` 内**。
    踩过的坑：用全树扫描 + `_is_conversation_item` 会把**聊天区的消息行**
    （头像 + 文本 + 时间）也认成会话项，于是"会话列表"里出现的是消息正文，
    真实会话反而被判为"已从列表消失"而被归档（实测把一条活跃会话误归档了）。

    容器不存在或为空时返回空列表 —— 调用方据此跳过归档，避免误伤。
    """
    container = None
    for node in descendants(tree):
        if (node.get("aid") or "") == CONV_LIST_AID:
            container = node
            break
    if container is None:
        return []

    keys = []
    for node in descendants(container):
        if not _is_conversation_item(node):
            continue
        _left, right = node["children"]
        texts = subtree_texts(right)
        if not texts or not texts[0]:
            continue
        keys.append(digest12(f"{shop_name}|{digest12(normalize_text(texts[0]))}"))
    return keys


def extract_shop(leaves: list[dict], shop_title: str) -> dict:
    """店铺名：优先窗口标题的 [商家]xxx。"""
    from_title = shop_title.replace("[商家]", "").strip() if shop_title else ""
    return {
        "raw": from_title,
        "from_window_title_masked": mask_nickname(from_title),
        "from_window_title_redacted": asdict(Redacted.of(from_title)),
    }


def extract_agent_status(tree: dict) -> dict:
    """客服接待状态。标签实测会随状态变化（小休 / 上线 / 在线 / 离线），
    这里覆盖常见取值；取不到不算失败，状态只是展示信息。"""
    hints = ("小休", "上线", "下线", "在线", "离线", "忙碌", "接单")
    for node in descendants(tree):
        name = node["name"]
        if name and any(k in name for k in hints):
            return {"found": True, "text": name}
    return {"found": False, "text": ""}


# --------------------------------------------------------------------------
# 会话列表（结构化定位）
# --------------------------------------------------------------------------

def _is_conversation_item(node: dict) -> bool:
    """会话项判定：恰好 2 个子节点，左支是头像（窄），右支是文本（宽）。

    实测结构：
      item(kids=2)
        ├ 左支 44x36  → ImageControl '头像' + GroupControl '<未读徽标>'
        └ 右支 231x40 → TextControl '<昵称>' + GroupControl '<预览行>'

    用结构而不是"拍平文本后按头像切段"——后者会把右支预览里的商品价格
    （¥260.00）误判成未读徽标。
    """
    kids = node.get("children", [])
    if len(kids) != 2:
        return False
    left, right = kids
    if not (has_rect(left) and has_rect(right)):
        return False
    if not has_image_named(left, "头像"):
        return False
    left_w = left["rect"]["width"]
    right_w = right["rect"]["width"]
    # 左支只放头像+徽标（窄），右支放昵称+预览（宽）
    return left_w <= 90 and right_w > 90 and left["rect"]["left"] < right["rect"]["left"]


def extract_conversation_list(tree: dict) -> list[dict]:
    items: list[dict] = []
    for node in descendants(tree):
        if not _is_conversation_item(node):
            continue
        left, right = node["children"]

        # 未读徽标：只在左支里找纯数字（右支的价格永远不会被误判）
        badge: Optional[int] = None
        for cand in descendants(left):
            name = cand["name"]
            if cand["type"] in ("TextControl", "GroupControl") and re.fullmatch(r"\d{1,3}", name):
                badge = int(name)
                break

        # 昵称 + 预览：右支文本按文档序，首个为昵称
        texts = subtree_texts(right)
        nickname = texts[0] if texts else ""
        rest = texts[1:]

        rel_time = ""
        previews: list[str] = []
        for text in rest:
            if not rel_time and REL_TIME_RE.match(text):
                rel_time = text
                continue
            if text in NOISE or text in READ_STATES or ABS_TIME_RE.match(text):
                continue
            if any(h in text for h in SENT_BY_HINTS):
                continue
            previews.append(text)

        items.append({
            "index": len(items),
            "nickname_masked": mask_nickname(nickname),
            "nickname_redacted": asdict(Redacted.of(nickname)),
            "unread_badge": badge,
            "has_unread": bool(badge),
            "relative_time": rel_time,
            "preview_digests": [digest12(normalize_text(p)) for p in previews[:6]],
            "preview_count": len(previews),
            "rect": node.get("rect"),
        })
    return items


# --------------------------------------------------------------------------
# 消息（结构化定位 + 发送者归属）
# --------------------------------------------------------------------------

def _is_message_block(node: dict) -> bool:
    """消息块判定：子树内恰好 1 个头像 且 恰好 1 个时间戳。

    实测结构（机器人消息）：
      block(kids=3)
        ├ GroupControl → ImageControl '头像'        （右对齐 x≈2195）
        ├ TextControl '智能客服'                     ← 角色标签
        └ GroupControl → 内容 / 时间 / 已读

    实测结构（客户消息）：
      block(kids=2)
        ├ GroupControl → ImageControl '头像'
        └ GroupControl → 内容 / 时间 / (空)          ← 没有角色标签
    """
    if count_image_named(node, "头像") != 1:
        return False
    stamps = [n for n in descendants(node) if ABS_TIME_RE.match(n["name"])]
    return len(stamps) == 1


def _trim_blocks(tree: dict) -> list[dict]:
    """自顶向下取最浅的消息块，不再深入已识别的块，避免嵌套重复。"""
    blocks: list[dict] = []

    def visit(node: dict) -> None:
        for child in node.get("children", []):
            if _is_message_block(child):
                blocks.append(child)
            else:
                visit(child)

    visit(tree)
    return blocks


def _descendants_upto(node: dict, max_depth: int):
    queue = [(node, 0)]
    while queue:
        current, depth = queue.pop(0)
        if depth > max_depth:
            continue
        yield current
        for child in current.get("children", []):
            queue.append((child, depth + 1))


def _role_label_of(block: dict) -> str:
    """在消息块内（限深 2 层）寻找角色标签 —— 结构性发送者信号。

    实测机器人消息块的标签是块根的直接子 TextControl，但不同消息形态下
    可能多包一层容器，因此限深搜索而不是只看直接子节点。
    """
    for node in _descendants_upto(block, 2):
        name = node["name"]
        if node["type"] != "TextControl" or not name:
            continue
        if name in ROLE_LABELS:
            return name
    for node in _descendants_upto(block, 2):
        name = node["name"]
        if node["type"] == "TextControl" and name.startswith("客服"):
            return name
    return ""


def _avatar_rect(block: dict) -> Optional[dict]:
    for node in descendants(block):
        if node["type"] == "ImageControl" and node["name"] == "头像" and has_rect(node):
            return node["rect"]
    return None


def _direct_text_labels(block: dict) -> list[str]:
    """块根的直接子 TextControl = 发送者署名槽位。

    实测机器人/系统消息在该槽位放角色标签（`智能客服` / `系统消息`）；客户消息
    没有该槽位。

    ⚠️ 已知缺陷：**人工点击发送的消息**该槽位放的是店铺署名，且实测该节点不是
    TextControl 而是 GroupControl，因此这里取不到，导致这类消息的正文会把店铺
    署名一起拼进去（实测 13 字符正文变成 21），发送者也会回落成"客户"。
    曾尝试放宽为「任何有名字的直接子节点」，但会误伤其它消息块（把界面标签
    误判成发送者），因此回退到保守版本。修复需要单独的规则，见报告"待办"。

    另注：不能用窗口标题里的店铺名做字符串匹配剔除——实测窗口标题是
    「孤勇者科隔热材料」而消息署名是「孤勇者隔热材料」，两者不一致。
    """
    labels = []
    for child in block.get("children", []):
        if child["type"] != "TextControl":
            continue
        name = child["name"]
        if not name or name in READ_STATES or ABS_TIME_RE.match(name):
            continue
        if any(h in name for h in SENT_BY_HINTS):
            continue
        labels.append(name)
    return labels


SLOT_MAX_DEPTH = 3


def _slot_names(block: dict) -> list:
    """块内"署名槽位"里的短文本：角色标签（智能客服/系统消息）或本店署名。

    **限深 3 层、不限控件类型**。实测结构是
        块根 -> 未命名 Group -> 未命名 Group -> [署名/角色标签 / 内容 / 时间]  (第 3 层)
    所以按"直接子节点"取会一个都取不到（曾因此让署名学习失败、方向全判错）。
    只找 TextControl 也不行：本店署名实测是 GroupControl。

    返回的短文本可能包含正文（例如客户只说"No"），调用方必须做
    "排除后正文为空则回退"的保护，见 extract_messages。
    """
    names = []
    for node in _descendants_upto(block, SLOT_MAX_DEPTH):
        if node is block:
            continue
        name = (node.get("name") or "").strip()
        if not name or len(name) > 20:
            continue
        if name in READ_STATES or ABS_TIME_RE.match(name) or name == "头像":
            continue
        if any(hint in name for hint in SENT_BY_HINTS):
            continue
        names.append(name)
    return names


def _learn_shop_signature(blocks: list) -> str:
    """从数据里学出"本店署名"。

    依据：只有本店/系统发出的消息块在署名槽位有文本，客户消息块该槽位为空。
    因此跨块出现次数最多的非角色标签短文本就是本店署名。

    这样就不用去猜——窗口标题是"孤勇者科隔热材料"，而消息里署名是
    "孤勇者隔热材料"，两者不等，按标题做字符串匹配是匹配不上的。
    """
    counter = collections.Counter()
    for block in blocks:
        for name in _slot_names(block):
            if name in ROLE_LABELS:
                continue
            counter[name] += 1
    if not counter:
        return ""
    candidate, count = counter.most_common(1)[0]
    # 只出现一次的多半是偶发正文而不是稳定署名
    return candidate if count >= 2 else ""


CHAT_AID = "workspace-chat"

# 飞鸽工作台自身的控件文字。它们不是客户说的话，但会出现在元素树里
# （统计挂件、搜索框占位符、列表头），一旦被当成消息块就会把整串 UI 文案采成一条消息
# （实测采到过 "飞鸽平均响应时长\n48\n秒\n店\n1\n今日接待人数\n1\n店\n1\n用户昵称/订单号/会话记录(Ctrl+F)"）。
CHROME_MARKERS = (
    "飞鸽平均响应时长", "今日接待人数", "用户昵称/订单号/会话记录",
    "列表设置", "等待时长", "不分组", "飞鸽收不到客户咨询消息",
    "商家后台", "添加备注", "最近联系", "平台消息",
)


def _looks_like_chrome(text: str) -> bool:
    if not text:
        return False
    hits = sum(1 for marker in CHROME_MARKERS if marker in text)
    return hits >= 2


# 商品卡里的噪音文案：保障/优惠/物流标签与操作按钮，不是商品信息
CARD_NOISE = (
    "保障", "优惠", "物流", "券后价", "已售", "极速退款", "7天无理由退货",
    "平台券", "立减", "预计明天发货", "现货", "计算价格", "邀请下单", "规格", "属性",
    "包邮", "运费险", "服务",
)
PRICE_SYMBOLS = ("￥", "¥", "$")


def _extract_card_fields(texts: list) -> tuple:
    """从商品卡块里抽出**名字**与**售价**，其余都是噪音。

    售价在元素树里是拆开的（实测为 "￥" / "252" / "." / "00" 四个独立节点），
    所以要把 ¥ 标记后紧跟的数字与小数点节点拼起来。
    名字取最长的一条、且不像噪音/按钮/数字的文本。
    """
    price = ""
    for index, text in enumerate(texts):
        if text not in PRICE_SYMBOLS:
            continue
        buf = []
        for nxt in texts[index + 1:index + 6]:
            if re.fullmatch(r"[\d.]+", nxt):
                buf.append(nxt)
            else:
                break
        candidate = "".join(buf)
        if candidate and re.search(r"\d", candidate):
            price = f"{text}{candidate}"
            break

    name = ""
    for text in texts:
        if not text or text in PRICE_SYMBOLS:
            continue
        if re.fullmatch(r"[\d.]+", text):
            continue
        if any(noise in text for noise in CARD_NOISE):
            continue
        if text in READ_STATES or ABS_TIME_RE.match(text) or text == "头像":
            continue
        if any(hint in text for hint in SENT_BY_HINTS):
            continue
        if len(text) > len(name):
            name = text
    return name, price


def extract_messages(tree: dict, shop_name: str = "") -> list[dict]:
    """按消息块提取，方向由结构性信号判定（不猜内容）。

    只取**聊天容器 `workspace-chat` 内**的消息块；容器找不到时退回整棵树，
    但会用 CHROME_MARKERS 过滤掉明显的界面控件文案。
    """
    messages: list[dict] = []

    chat_root = None
    for node in descendants(tree):
        if (node.get("aid") or "") == CHAT_AID:
            chat_root = node
            break
    blocks = _trim_blocks(chat_root if chat_root is not None else tree)

    shop_signature = _learn_shop_signature(blocks)

    for block in blocks:
        texts = subtree_texts(block)
        stamps = [t for t in texts if ABS_TIME_RE.match(t)]
        if not stamps:
            continue
        time_text = stamps[0]

        slot_names = _slot_names(block)
        role = next((n for n in slot_names if n in ROLE_LABELS), "")
        if not role:
            role = next((n for n in slot_names if n.startswith("客服")), "")
        # 署名槽位出现"本店署名"= 这条是本店发出的
        signed_by_shop = bool(shop_signature) and shop_signature in slot_names
        sent_by = next((t for t in texts if any(h in t for h in SENT_BY_HINTS)), "")
        read_state = next((t for t in texts if t in READ_STATES), "")

        def build_content(excluded: list) -> list:
            return [
                t for t in texts
                if t not in READ_STATES
                and t not in excluded
                and not ABS_TIME_RE.match(t)
                and not any(h in t for h in SENT_BY_HINTS)
                and t not in ("头像",)
            ]

        content_parts = build_content(slot_names)
        if not content_parts:
            # 回退：排除"署名槽位"后什么都不剩，说明那些短文本其实是正文
            # （例如客户只发了 "No"）。此时不把它们当署名，否则整条消息会被丢掉。
            content_parts = build_content([])
            role = ""
            signed_by_shop = False

        # 头像水平位置：消息区右侧 = 本店发出，左侧 = 客户发来
        avatar = _avatar_rect(block)
        block_rect = block.get("rect")
        avatar_right_aligned: Optional[bool] = None
        if avatar and block_rect and block_rect.get("width"):
            avatar_center = avatar["left"] + avatar["width"] / 2
            block_center = block_rect["left"] + block_rect["width"] / 2
            avatar_right_aligned = avatar_center > block_center

        # 方向判定：署名槽位 > 角色标签 > 发送方说明 > 已读态+头像对齐。
        # 顺序很关键：本店手工发送的消息既有"本店署名"又有"已读"，必须优先按署名判 out，
        # 否则一旦头像对齐信息缺失就会落进默认分支被当成客户消息（实测发生过，很危险：
        # 节点只上报 in，本店消息会被当作客户消息入库）。
        if role == "系统消息":
            direction, basis = "system", "role_label=系统消息"
        elif signed_by_shop:
            direction, basis = "out", f"shop_signature={shop_signature}"
        elif role:
            direction, basis = "out", f"role_label={role}"
        elif sent_by:
            direction, basis = "out", f"sent_by={sent_by[:12]}"
        elif avatar_right_aligned is True and read_state:
            direction, basis = "out", "avatar_right+read_state"
        elif avatar_right_aligned is False:
            direction, basis = "in", "avatar_left"
        else:
            # 无任何标签/署名 = 客户消息（这是结构性规律：本店与系统的消息块在署名
            # 槽位一定有内容，客户消息块该槽位为空）。
            # 之前这里保守判成 out，结果把 'No'/'我会被晒黑吗' 这类客户消息全扔掉了；
            # 现在本店消息已由 shop_signature / role_label / sent_by 三道拦下，可以放心默认 in。
            direction, basis = "in", "no_label(默认客户)"

        # 正文：剔除时间/已读态/头像/发送方说明，以及署名槽位里的全部文本
        # （角色标签与本店署名都不该出现在正文里）；若排除后为空则已在上面回退。
        content = normalize_text("\n".join(content_parts))
        if not content:
            continue
        # 控件文案兜底过滤（容器找不到时会退回整棵树，这里是第二道闸）
        if _looks_like_chrome(content):
            continue

        # 指纹锚点：取「最长的单个内容节点」而不是全部节点拼接。
        # 富媒体卡片（商品卡）的拼接结果会因懒渲染子节点出现/消失而抖动 ±1~3 字符
        # （实测 265/267/268），但卡片主体文本本身是稳定的；对纯文本消息，最长节点
        # 就是消息本身，因此这个锚点对两类消息都稳定。
        longest = max(content_parts, key=len) if content_parts else ""
        anchor = normalize_text(longest)

        # 发送者名称：角色标签 > 发送方说明 > 本店署名（人工发送）> 客户
        if role:
            sender_label = role
        elif sent_by:
            sender_label = "商家" if "商家" in sent_by else "智能客服"
        elif signed_by_shop:
            sender_label = shop_signature
        else:
            sender_label = ""

        # 媒体图片位置：块内**非头像**的那个图片节点就是表情/图片本体
        # （实测它的 name 与占位文字相同，都是方括号标签，如 name='[发呆]'）。
        # 只取已布局的：滚出视野的节点 rect 是 0x0，截不到。
        media_rect = None
        media_label = ""
        for node in descendants(block):
            if node.get("type") != "ImageControl":
                continue
            name = (node.get("name") or "").strip()
            if name == "头像":
                continue
            rect = node.get("rect") or {}
            if int(rect.get("width") or 0) >= 20 and rect.get("left"):
                media_rect = rect
                media_label = name
                break

        # 富媒体卡片（商品卡等）判定：块内出现按钮（计算价格/邀请下单/规格属性），
        # 或正文较长且带图片。这类内容光靠文字表达不了，需要整块截图。
        # 与之相对，表情（content 是 [抱紧自己] 这种短标签）不需要截图，标签就够。
        has_buttons = any(n.get("type") == "ButtonControl" for n in descendants(block))
        is_card = has_buttons or (media_rect is not None and len(content) > 40)
        card_rect = None
        card_name = ""
        card_price = ""
        if is_card:
            card_name, card_price = _extract_card_fields(texts)
            if card_name:
                # 卡片只保留 **名字 + 售价**：保障/优惠/物流/按钮那些都是噪音，
                # 全塞进正文会让工作台里显示一大坨没用的东西。
                content = f"{card_name}  {card_price}".strip()
            rect = block.get("rect") or {}
            if int(rect.get("width") or 0) >= 40 and rect.get("left"):
                card_rect = rect

        messages.append({
            "order": len(messages),
            "direction": direction,
            "direction_basis": basis,
            "media_rect": media_rect,
            "media_label": media_label,
            "is_card": is_card,
            "card_rect": card_rect,
            "card_name": card_name,
            "card_price": card_price,
            "sender_label": sender_label,
            "sender_masked": mask_nickname(sender_label) if sender_label else "客户",
            "sender_key": digest12(sender_label) if sender_label else digest12("customer"),
            "time_text": time_text,
            "read_state": read_state,
            "content_length": len(content),
            "content_digest": digest12(content),
            # 真实正文：业务库需要它（否则界面只显示 digest 占位符）。
            # 注意 out/ 已 gitignore，快照里会带原文，不要提交。
            "content_raw": content,
            "content_anchor_length": len(anchor),
            "content_anchor_digest": digest12(anchor),
        })

    return messages


def assign_occurrences(messages: list[dict]) -> None:
    seen: dict[tuple, int] = {}
    for msg in messages:
        key = (msg["direction"], msg["sender_key"], msg["time_text"], msg["content_digest"])
        msg["occurrence"] = seen.get(key, 0)
        seen[key] = msg["occurrence"] + 1


def fingerprint(msg: dict, conversation_key: str) -> str:
    """稳定指纹：绝对时间锚点 + 内容锚点（最长单节点），避免富媒体卡片的拼接抖动。"""
    parts = [
        ADAPTER_ID, "main", conversation_key, msg["direction"], msg["sender_key"],
        msg["time_text"], msg.get("content_anchor_digest") or msg["content_digest"],
        str(msg.get("occurrence", 0)),
    ]
    return sha256_hex("\x1f".join(parts))


def snapshot() -> dict:
    host = resolve_render_host()
    tree = build_tree(host["control"])
    shop = extract_shop([], host["shop_title"])
    status = extract_agent_status(tree)
    convs = extract_conversation_list(tree)
    messages = extract_messages(tree, shop_name=shop.get("raw", ""))
    assign_occurrences(messages)

    # 会话键：店铺 + 当前会话客户昵称（topbar 里的昵称）
    conv_key = digest12((shop["from_window_title_redacted"]["digest"] or "") + "|" +
                        (convs[0]["nickname_redacted"]["digest"] if convs else ""))
    for msg in messages:
        msg["fingerprint"] = fingerprint(msg, conv_key)

    return {
        "at": now_iso(),
        "main_hwnd": host["main_hwnd"],
        "render_host_hwnd": host["render_host_hwnd"],
        "leaf_count": sum(1 for n in descendants(tree) if n["name"]),
        "shop": shop,
        "agent_status": status,
        "conversation_count": len(convs),
        "unread_conversations": sum(1 for c in convs if c["has_unread"]),
        "conversations": convs[:20],
        "message_count": len(messages),
        "conversation_key": conv_key,
        "messages": messages,
    }


def redacted_view(state: dict) -> dict:
    out = dict(state)
    out["messages"] = [
        {k: v for k, v in m.items() if k != "content_digest"} | {"content_digest": m["content_digest"]}
        for m in state["messages"]
    ]
    return out


# --------------------------------------------------------------------------
# 子命令
# --------------------------------------------------------------------------

def cmd_read(args: argparse.Namespace) -> int:
    state = snapshot()
    os.makedirs(OUT_DIR, exist_ok=True)
    out = args.out or os.path.join(OUT_DIR, "extract.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)

    print(f"渲染宿主 hwnd={state['render_host_hwnd']} 文本节点={state['leaf_count']}")
    print(f"店铺: {state['shop']['from_window_title_masked']}")
    print(f"客服状态: {state['agent_status']['text']}")
    print(f"会话数: {state['conversation_count']} 有未读: {state['unread_conversations']}")
    for conv in state["conversations"]:
        print(f"  [{conv['index']}] {conv['nickname_masked']} 未读={conv['unread_badge']} "
              f"时间={conv['relative_time']!r} 预览{conv['preview_count']}行")
    print(f"当前会话消息数: {state['message_count']}")
    for msg in state["messages"]:
        print(f"  #{msg['order']:>2} [{msg['direction']:<6}] t={msg['time_text']:<9} "
              f"sender={msg['sender_masked']:<6} len={msg['content_length']:<4} "
              f"anchor={msg['content_anchor_length']:<4} read={msg['read_state'] or '-':<3} "
              f"依据={msg['direction_basis']}")
    print(f"\n-> {out}")
    return 0


def cmd_dedupe(args: argparse.Namespace) -> int:
    rounds = []
    for i in range(args.rounds):
        state = snapshot()
        rounds.append(state)
        fps = {m["fingerprint"] for m in state["messages"]}
        print(f"轮 {i+1}: {state['message_count']} 条消息, {len(fps)} 个唯一指纹")
        if i + 1 < args.rounds:
            time.sleep(args.interval)

    sets = [{m["fingerprint"] for m in r["messages"]} for r in rounds]
    non_empty = [s for s in sets if s]
    stable = all(s == non_empty[0] for s in non_empty[1:]) if len(non_empty) >= 2 else None

    ledger: set = set()
    dupes = 0
    for s in sets:
        for fp in s:
            if fp in ledger:
                dupes += 1
            else:
                ledger.add(fp)

    payload = {
        "generated_at": now_iso(),
        "rounds": args.rounds,
        "interval_seconds": args.interval,
        "message_counts": [r["message_count"] for r in rounds],
        "unique_per_round": [len(s) for s in sets],
        "stable_across_rounds": stable,
        "ledger_size": len(ledger),
        "duplicates_prevented": dupes,
        "union": len(set().union(*sets)) if sets else 0,
        "sample": rounds[0]["messages"][:25] if rounds else [],
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    out = args.out or os.path.join(OUT_DIR, "extract_dedupe.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    print()
    print(f"每轮条数: {payload['message_counts']}")
    print(f"唯一指纹: {payload['unique_per_round']}")
    print(f"跨轮稳定: {stable}")
    print(f"账本 {len(ledger)} 条，拦下重复入库 {dupes} 条")
    print(f"-> {out}")
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    print(f"监听 {args.seconds}s（间隔 {args.interval}s）…")
    base = snapshot()
    known = {m["fingerprint"] for m in base["messages"]}
    print(f"基线: {base['message_count']} 条消息, 会话 {base['conversation_count']} 个")
    events = []
    deadline = time.time() + args.seconds
    while time.time() < deadline:
        time.sleep(args.interval)
        cur_state = snapshot()
        cur = {m["fingerprint"] for m in cur_state["messages"]}
        new = sorted(cur - known)
        gone = sorted(known - cur)
        if new or gone:
            events.append({
                "at": cur_state["at"],
                "new_count": len(new),
                "new_fingerprints": new[:10],
                "removed_count": len(gone),
                "message_count": cur_state["message_count"],
                "conversation_count": cur_state["conversation_count"],
            })
            print(f"  [{cur_state['at']}] +{len(new)} 新消息, -{len(gone)}")
            for msg in cur_state["messages"]:
                if msg["fingerprint"] in new[:10]:
                    print(f"      [{msg['direction']}] t={msg['time_text']} "
                          f"sender={msg['sender_masked']} len={msg['content_length']}")
            known = cur

    payload = {
        "generated_at": now_iso(),
        "duration_seconds": args.seconds,
        "interval_seconds": args.interval,
        "baseline_message_count": base["message_count"],
        "mechanism": "UIA 轮询比对渲染宿主子树的指纹集合",
        "detected_changes": len(events),
        "events": events,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    out = args.out or os.path.join(OUT_DIR, "extract_watch.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    print(f"\n检测到 {len(events)} 次变化 -> {out}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="飞鸽客服系统字段提取（只读）")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("read", help="读取店铺/会话列表/消息")
    a.set_defaults(func=cmd_read)
    a.add_argument("--out", default=None)

    b = sub.add_parser("dedupe", help="指纹稳定性与去重")
    b.set_defaults(func=cmd_dedupe)
    b.add_argument("--rounds", type=int, default=3)
    b.add_argument("--interval", type=float, default=2.0)
    b.add_argument("--out", default=None)

    c = sub.add_parser("watch", help="监听新消息")
    c.set_defaults(func=cmd_watch)
    c.add_argument("--seconds", type=float, default=60.0)
    c.add_argument("--interval", type=float, default=2.0)
    c.add_argument("--out", default=None)
    return p


def main() -> int:
    args = build_parser().parse_args()
    auto.SetGlobalSearchTimeout(1)
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
