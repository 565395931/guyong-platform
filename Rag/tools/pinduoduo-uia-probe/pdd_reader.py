#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""拼多多工作台「客服」模块聊天读取器（视觉方案：截图 + OCR + 点击）。

适配布局（2026-10-13 实测，客服工作台）
----------------------------------------
- 左侧面板：按状态分组的会话区
  分组标题：待回复·N / 已超时48小时待回复·N / 夜间待成交·N / 已被自动回复·N / 已回复·N
  分组下是会话项（计数为 0 时无项）。
- 中间：聊天区（客户消息在左、我方消息在右，时间分隔线居中）。
- 右侧：买家订单面板（本读取器忽略）。

增量方案（用户要求：不滚动，靠指纹）
------------------------------------
每轮读分组计数与会话项 → 与上轮对比 → 只点开有变化的会话 → 解析消息 →
按指纹（会话+方向+时间+正文+出现序号）与已读集合比对，只上报新增。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from pdd_client import (  # noqa: E402
    OUT_DIR, capture_and_ocr, click_at, ensure_dpi_aware, find_main_window,
    normalize_text, ocr_image,
)
from pdd_layout import detect_bubbles, masked_customer_name, ocr_bubbles  # noqa: E402


def ocr_region(png_path: str, region_box, base_scale: int,
               extra_zoom: int = 2) -> list[dict]:
    """把已保存的截图按区域裁剪、再放大，单独 OCR（提升小字识别率），
    并把坐标映射回整图坐标系（base_scale 的 2x 空间）。"""
    from PIL import Image

    img = Image.open(png_path)
    W2, H2 = img.size
    (xr, yr) = region_box
    x0, y0 = int(xr[0] * W2), int(yr[0] * H2)
    x1, y1 = int(xr[1] * W2), int(yr[1] * H2)
    crop = img.crop((x0, y0, x1, y1))
    crop = crop.resize((crop.width * extra_zoom, crop.height * extra_zoom),
                       Image.LANCZOS)
    region_png = os.path.join(OUT_DIR, "pdd_region.png")
    crop.save(region_png)
    lines = ocr_image(region_png)
    out = []
    for ln in lines:
        ln["text"] = normalize_text(ln["text"])
        ln["x"] = int(x0 + ln["x"] / extra_zoom)
        ln["y"] = int(y0 + ln["y"] / extra_zoom)
        ln["width"] = int(ln["width"] / extra_zoom)
        ln["height"] = int(ln["height"] / extra_zoom)
        out.append(ln)
    out.sort(key=lambda l: (l["y"], l["x"]))
    return out

# 区域（窗口宽高比例）
LEFT_X = (0.033, 0.235)     # 左侧会话面板（飞桨报的项文字 x≈0.039W；0.033 起，仍排除图标导航条）
MIDDLE_X = (0.228, 0.695)   # 中间聊天区（实测右边界约 0.70W）
MIDDLE_Y = (0.235, 0.755)  # 只取消息带：上排除标题/横幅，下排除输入区/提示条
MIDDLE_TITLE_Y = (0.11, 0.18)   # 聊天区顶部：会话标题（客户名）
PANEL_BOX = (LEFT_X, (0.05, 0.99))
CHAT_BOX = (MIDDLE_X, MIDDLE_Y)
SIDE_SPLIT = 0.475          # 中间区里：行起点 x < 0.475W → 客户（左）；否则我方（右）
DIVIDER_X = (0.36, 0.57)    # 时间分隔线（居中于中间区）
ROW_GAP = 45
BLOCK_GAP = 55

TIME_RE = re.compile(r"^(\d{1,2}[:：]\d{2}|\d{1,2}/\d{1,2}\s*\d{1,2}[:：]\d{2})$")
GROUP_RE = re.compile(r"^(待回复|已超时\d*小时待回复|夜间待成交|已被自动回复|已回复|待办任务|全部会话)\s*[·．.]\s*(\d+)$")
EMPTY_HINTS = ("请点击左侧会话与买家聊天", "将窗口最大化", "暂无对话", "未选择会话")
# 元数据行（阅读状态/来源/账号名标签）与界面杂音（横幅/提示条）——都不是聊天消息
META_LINES = ("已读", "未读", "主账号", "目机", "来目机", "来自手机端", "来自电脑端")
META_PREFIX = ("来自手机", "来自电脑", "主账号")
NOISE_SUBSTR = ("机器人套餐", "续费", "严禁添加", "诱导", "违规", "服务用语",
                "文字聊天", "语音", "快捷回复", "机器人不再回", "要求人工",
                "打款", "收款", "已退出接待", "添加备注", "点此", "没有更多",
                "刷新", "舰店", "当前用户来自", "机器人", "自动回复",
                "旗舰店", "AIEBS", "艾贝斯", "品视店")  # 水印/店名（斜水印被 OCR 读出）


def image_size(main: dict, scale: int) -> tuple[int, int]:
    return int(main["rect"]["width"] * scale), int(main["rect"]["height"] * scale)


def _cx(ln: dict) -> float:
    return ln["x"] + ln["width"] / 2


def _cy(ln: dict) -> float:
    return ln["y"] + ln["height"] / 2


def _in_left(ln: dict, W: int, H: int) -> bool:
    return LEFT_X[0] * W <= _cx(ln) <= LEFT_X[1] * W and 0.05 * H <= _cy(ln) <= 0.99 * H


def _norm_label(text: str) -> str:
    """去掉 OCR 可能带上的前导符号（▼/√ 等）。"""
    return re.sub(r"^[^\u4e00-\u9fff\w]+", "", text.strip())


# 分组名容错匹配（OCR 实测会错：夜间→夜闫、已被自动回复→已被动回复、·0→司）
GROUP_KEYS = (
    # 「待办」页签下的分组
    ("已超时", "已超时48小时待回复"),
    ("已被", "已被自动回复"),
    ("夜", "夜间待成交"),
    ("待办任务", "待办任务"),
    ("已回复", "已回复"),
    ("待回复", "待回复"),
    # 「全部会话」页签下的分组（实测两套名字并存，按页签切换）
    ("收藏会话", "收藏会话"),
    ("咨询未下单", "咨询未下单"),
    ("咨询下单未付款", "咨询下单未付款"),
    ("疑似垃圾消息", "疑似垃圾消息"),
    ("官方客服", "官方客服"),
    ("服务市场", "服务市场"),
    ("全部会话", "全部会话"),
)


def _match_group(text: str):
    """面板行 → (标准分组名, 计数) 或 None。按 OCR 错读规律做容错。"""
    t = text.strip()
    # "已被自动回复" 的 OCR 变体最多（已被动回复/已目动回复/已自动回复）
    if t.startswith("已") and "动" in t and "回复" in t and "超时" not in t:
        m = re.search(r"(\d+)\s*$", t)
        return "已被自动回复", int(m.group(1)) if m else 0
    for key, canonical in GROUP_KEYS:
        if key in t:
            m = re.search(r"(\d+)\s*$", t)
            return canonical, int(m.group(1)) if m else 0
    return None


def parse_cs_panel(lines: list[dict], W: int, H: int) -> dict:
    """左侧面板 → {groups: [{label, count, y, items: [{name, preview, y}]}]}。"""
    rows = [ln for ln in lines
            if _in_left(ln, W, H) and _cy(ln) >= 0.30 * H
            and not any(k in ln["text"] for k in ("加载更多", "查看更多", "订阅"))]
    rows.sort(key=lambda l: l["y"])

    groups: list[dict] = []
    for ln in rows:
        matched = _match_group(_norm_label(ln["text"]))
        if matched:
            label, count = matched
            groups.append({"label": label, "count": count, "y": ln["y"], "items": []})

    # 分组标题之间的行 = 该组下的会话项（聚成簇）
    for i, grp in enumerate(groups):
        bottom = groups[i + 1]["y"] if i + 1 < len(groups) else H
        seg = [ln for ln in rows if grp["y"] < ln["y"] < bottom]
        clusters: list[list[dict]] = []
        for ln in seg:
            if clusters and ln["y"] - clusters[-1][-1]["y"] <= ROW_GAP:
                clusters[-1].append(ln)
            else:
                clusters.append([ln])
        for cluster in clusters:
            texts = [ln["text"].strip() for ln in cluster
                     if not TIME_RE.match(ln["text"].strip())]
            if not texts:
                continue
            grp["items"].append({
                "name": texts[0],
                "preview": " ".join(texts[1:])[:80],
                "y": cluster[0]["y"],
            })
    return {"groups": groups}


def parse_middle_chat(lines: list[dict], W: int, H: int) -> dict:
    """中间聊天区 → {title, messages: [...], empty: bool}。title = 顶部会话名。"""
    title = ""
    candidates = []
    for ln in lines:
        if (MIDDLE_X[0] * W <= _cx(ln) <= MIDDLE_X[1] * W
                and MIDDLE_TITLE_Y[0] * H <= _cy(ln) <= MIDDLE_TITLE_Y[1] * H):
            t = ln["text"].strip()
            if len(t) >= 1 and t not in ("男", "女") and "备注" not in t and "点此" not in t:
                candidates.append(ln)
    if candidates:
        # 标题在最左侧（右侧是"点此添加备注信息"等提示）
        pick = min(candidates, key=lambda l: l["x"])
        title = re.sub(r"\s*[男女肥]\s*$", "", pick["text"].strip())
    rows = [ln for ln in lines
            if MIDDLE_X[0] * W <= _cx(ln) <= MIDDLE_X[1] * W
            and MIDDLE_Y[0] * H <= _cy(ln) <= MIDDLE_Y[1] * H]
    rows.sort(key=lambda l: l["y"])

    if any(any(h in ln["text"] for h in EMPTY_HINTS) for ln in rows):
        return {"title": title, "messages": [], "empty": True}

    current_time = ""
    body: list[dict] = []
    pending_out = False
    LABEL_HINTS = ("自动回复", "机器人", "主账号", "客服叮叮", "来自手机端")
    expanded: list[dict] = []
    for ln in rows:
        parts = [p.strip() for p in ln["text"].split("\n") if p.strip()]
        for pi, part in enumerate(parts):
            item = dict(ln)
            item["text"] = part
            if pi > 0:
                item["y"] = ln["y"] + pi * 70  # 拆出的后续行下移 > BLOCK_GAP，避免被并回同一条
                item["x"] = ln["x"]
            expanded.append(item)
    for ln in expanded:
        text = ln["text"].strip()
        if any(h in text for h in LABEL_HINTS) and len(text) <= 30:
            pending_out = True  # 发送者标签行：下一条消息方向锁定为我方（out）
            continue
        if TIME_RE.match(text) and DIVIDER_X[0] * W <= _cx(ln) <= DIVIDER_X[1] * W:
            current_time = text.replace("：", ":")
            continue
        if re.match(r"^\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日", text):
            continue  # 日期分隔线（如 2026年10月13日16:17:49）
        if text in META_LINES or any(text.startswith(p) for p in META_PREFIX):
            continue
        for meta in ("主账号", "已读", "未读", "来自手机端", "来自电脑端"):
            if text.startswith(meta):
                text = text[len(meta):].strip(" |·，,")
                break
        if not text or len(text) < 2:
            continue
        if any(k in text for k in NOISE_SUBSTR):
            continue
        direction = "in" if ln["x"] < SIDE_SPLIT * W else "out"
        body.append({"y": ln["y"], "x": ln["x"], "width": ln.get("width", 0),
                     "height": ln.get("height", 0),
                     "text": text, "direction": direction,
                     "timeText": current_time,
                     "locked_out": pending_out})
        pending_out = False

    messages: list[dict] = []
    block: list[dict] = []
    for row in body:
        if (block and (row["direction"] != block[-1]["direction"]
                       or row["y"] - block[-1]["y"] > BLOCK_GAP)):
            messages.append(_finish_block(block))
            block = []
        block.append(row)
    if block:
        messages.append(_finish_block(block))
    return {"title": title, "messages": messages, "empty": False}


def _finish_block(block: list[dict]) -> dict:
    locked = any(row.get("locked_out") for row in block)
    return {
        "direction": "out" if locked else block[0]["direction"],
        "locked_direction": locked,
        "timeText": block[0]["timeText"],
        "text": "\n".join(row["text"] for row in block),
        "y": block[0]["y"],
    }


def fingerprint(conv_key: str, direction: str, time_text: str, text: str,
                occurrence: int) -> str:
    raw = f"pdd|{conv_key}|{direction}|{time_text}|{text}|{occurrence}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def to_iso_time(time_text: str, now: Optional[datetime] = None) -> str:
    """'16:00' → 今天 16:00；'06/14 22:00' → 最近的 6月14日。

    返回带本地时区偏移的 ISO（协议 timestamp 要求带 offset）。
    """
    now = now or datetime.now()
    m = re.match(r"^(\d{1,2})/(\d{1,2})\s+(\d{1,2}):(\d{2})$", time_text)
    if m:
        month, day, hh, mm = (int(x) for x in m.groups())
        year = now.year
        if (month, day) > (now.month, now.day):
            year -= 1
        return datetime(year, month, day, hh, mm).astimezone().isoformat(timespec="seconds")
    m = re.match(r"^(\d{1,2}):(\d{2})$", time_text)
    if m:
        return now.replace(hour=int(m.group(1)), minute=int(m.group(2)),
                           second=0, microsecond=0).astimezone().isoformat(timespec="seconds")
    return ""


def read_conversation_title(main: dict, scale: int) -> str:
    """单独放大识别聊天区顶部标题（客户名）。标题字号大、用整图 OCR 容易与右侧
    "点此添加备注信息"提示混淆，这里对标题带做 3x 裁剪识别并剔除提示词。"""
    png = os.path.join(OUT_DIR, "pdd_capture.png")
    if not os.path.exists(png):
        return ""
    box = ((MIDDLE_X[0], MIDDLE_X[0] + 0.16), MIDDLE_TITLE_Y)
    try:
        lines = ocr_region(png, box, scale, extra_zoom=3)
    except Exception:  # noqa: BLE001
        return ""
    for ln in lines:
        t = ln["text"].strip()
        if not t or "备注" in t or "点此" in t or "添加" in t:
            continue
        if any(ch in t for ch in "男女") and len(t) <= 2:
            continue
        t = re.sub(r"\s*[男女]\s*$", "", t).strip()
        if t:
            return t
    return ""


def apply_direction_by_color(png_path: str, messages: list[dict], scale: int) -> None:
    """按气泡底色修正每条消息的方向：白底=客户(in)，蓝色=我方(out)。

    为什么不用 x 坐标：客户端把同一方的连续消息分组——组内第一条带头像、后续气泡缩进，
    缩进后的客户气泡和蓝色气泡的起点会重叠（实测 490 vs 487），按 x 判必串。
    颜色判据实测可靠：客户白底卡片 / 我方（含机器人自动回复）浅蓝气泡。
    """
    try:
        from PIL import Image
        img = Image.open(png_path).convert("RGB")
    except Exception:  # noqa: BLE001
        return
    px = img.load()
    for msg in messages:
        if msg.get("locked_direction"):
            continue  # 发送者标签已锁定方向（如自动回复白底气泡），颜色不再覆盖
        rect = msg.get("rect")
        if not rect:
            continue
        x0 = max(0, rect["x"]); x1 = min(img.width - 1, rect["x"] + rect["width"])
        y0 = max(0, rect["y"]); y1 = min(img.height - 1, rect["y"] + rect["height"])
        if x1 <= x0 or y1 <= y0:
            continue
        blue = total = 0
        for y in range(y0, y1 + 1, 2):
            for x in range(x0, x1 + 1, 3):
                r, g, b = px[x, y]
                total += 1
                if b > 225 and (b - r) > 18 and g > 200:
                    blue += 1
        if total:
            msg["direction"] = "out" if (blue / total) > 0.25 else "in"


class PddSentinel:
    """方案 A：双哨兵低成本触发（替代高频全量轮询）。

    ① 窗口哨兵：只枚举**拼多多进程**（PddWorkbench/pddwebworkbench）的顶层窗口，
       盯"消息提示/消息预览"类浮窗的出现与显隐/位置变化（纯 Win32 查询，微秒级）。
    ② 像素哨兵：客户端处于前台时，对左侧面板小区域截图做哈希差分（毫秒级）；
       不在前台时跳过（后台截图可能是旧帧，避免误判——靠窗口哨兵和兜底全读覆盖）。

    ⚠️ 多平台共存原则：所有检查都先按"进程名含 pdd/拼多多"过滤——飞鸽、千帆
    以及其它平台的窗口/通知一律不参与本哨兵（它们的进程名不同，天然隔离）。
    """

    PDD_PROCESS_HINTS = ("PddWorkbench", "pddwebworkbench", "PDDWBGd")
    NOTICE_TITLE_KEYS = ("消息提示", "消息预览", "商家消息窗口")
    NOTICE_CLASS_KEYS = ("Notice", "Tip", "Msg", "Preview")

    def __init__(self):
        self._baseline = None
        self._panel_sig = None

    @staticmethod
    def _pdd_process(proc_name: str) -> bool:
        return any(h.lower() in proc_name.lower() for h in PddSentinel.PDD_PROCESS_HINTS)

    def _notice_state(self) -> dict:
        out = {}
        try:
            from qianfan_capture import (enum_top_level, get_class_name, get_pid,
                                         get_rect, get_window_text, process_name)
            user32 = _ct.windll.user32
            for hwnd in enum_top_level():
                proc = process_name(get_pid(hwnd))
                if not self._pdd_process(proc):
                    continue
                title = get_window_text(hwnd)
                cls = get_class_name(hwnd)
                if any(k in title for k in self.NOTICE_TITLE_KEYS) or                    any(k in cls for k in self.NOTICE_CLASS_KEYS):
                    out[hwnd] = (bool(user32.IsWindowVisible(hwnd)), get_rect(hwnd))
        except Exception:  # noqa: BLE001
            pass
        return out

    def tick(self, main: dict) -> bool:
        """跑一次低成本检查；返回 True 表示检测到变化、应交由完整读取。"""
        import ctypes as _ct
        changed = False
        state = self._notice_state()
        if self._baseline is None:
            self._baseline = state          # 首轮建立基线
        elif state != self._baseline:
            changed = True
            self._baseline = state
        # 像素哨兵：仅当前台时截图（后台帧可能过旧）
        try:
            user32 = _ct.windll.user32
            if user32.GetForegroundWindow() == main["hwnd"]:
                import hashlib
                from pdd_client import capture_window
                img = capture_window(main["hwnd"])
                crop = img.crop((int(img.width * 0.03), int(img.height * 0.27),
                                 int(img.width * 0.25), int(img.height * 0.82)))
                sig = hashlib.sha256(crop.tobytes()).hexdigest()[:16]
                if self._panel_sig is not None and sig != self._panel_sig:
                    changed = True
                self._panel_sig = sig
        except Exception:  # noqa: BLE001
            pass
        return changed


class PddChatReader:
    """客服模块聊天读取器：维护已读指纹，只产出新增消息。"""

    def __init__(self, scale: int = 2):
        self.scale = scale
        self.seen: set[str] = set()
        # 已"首次回翻"过的会话（用户约定：新客户第一次从最上面完整读；之后只核当前页）
        self.initialized: set[str] = set()
        self.last_group_state: dict[str, int] = {}
        self.last_item_state: dict[str, tuple] = {}

    def _initial_backfill(self, main: dict, key: str, name: str,
                          max_scrolls: int = 30) -> list[dict]:
        """首次见到该客户时：滚到最顶，再从上往下逐屏读完整历史（旧→新），
        读完点开会话回到最新。复用 pdd_backfill 的滚动/读取原语（懒加载避免循环导入）。"""
        import ctypes as _ct
        import hashlib as _hl
        import time as _time
        from pdd_backfill import read_viewport, wheel, NOTCHES_PER_PAGE

        user32 = _ct.windll.user32
        rect = main["rect"]
        user32.SetCursorPos(rect["left"] + int(rect["width"] * 0.45),
                            rect["top"] + int(rect["height"] * 0.45))
        _time.sleep(0.3)

        # 滚到顶
        for _ in range(30):
            wheel(NOTCHES_PER_PAGE)
            _time.sleep(0.5)
            try:
                msgs = read_viewport(main, self.scale)
            except Exception:  # noqa: BLE001
                continue
            if any("没有更多" in m["text"] for m in msgs):
                break
        _time.sleep(0.5)

        collected: list[dict] = []
        local_seen: set[str] = set()
        quiet = 0
        for _ in range(max_scrolls):
            try:
                msgs = read_viewport(main, self.scale)
            except Exception:  # noqa: BLE001
                break
            counters: dict[tuple, int] = {}
            fresh = 0
            for m in msgs:
                token = (m["direction"], m["text"])
                occ = counters.get(token, 0)
                counters[token] = occ + 1
                fp = _hl.sha256(f"pdd|{key}|{m['direction']}||{m['text']}|{occ}".encode()).hexdigest()[:32]
                if fp in local_seen or fp in self.seen:
                    continue
                local_seen.add(fp)
                fresh += 1
                collected.append({"direction": m["direction"], "text": m["text"],
                                  "timeText": m.get("timeText", ""), "fp": fp})
            if fresh == 0:
                quiet += 1
                if quiet >= 2:
                    break
            else:
                quiet = 0
            wheel(-NOTCHES_PER_PAGE)
            _time.sleep(1.0)

        # 回到底部（点开会话比滚轮可靠）
        try:
            panel_main, panel_lines = self._snapshot(focus="panel")
            self._click_by_name(panel_main, name, panel_lines)
            _time.sleep(1.0)
        except Exception:  # noqa: BLE001
            wheel(-max_scrolls * NOTCHES_PER_PAGE)
        return collected

    def _snapshot(self, focus: Optional[str] = None):
        """截图 + OCR。focus='panel'/'chat' 时**只裁剪目标区域**（收紧裁剪，喂给
        PaddleOCR 的图更小、更快、更准），坐标统一映射回整窗 2x 空间。"""
        main = find_main_window()
        if main is None:
            raise RuntimeError("未找到拼多多工作台主窗口")
        # capture_and_ocr 保存整窗截图（并确保前台拿实时帧），识别只做区域裁剪
        capture_and_ocr(main, self.scale, ensure_fresh=True, do_ocr=False)
        png = os.path.join(OUT_DIR, "pdd_capture.png")
        if not focus:
            return main, ocr_region(png, ((0.0, 1.0), (0.0, 1.0)), self.scale, extra_zoom=1)
        box = PANEL_BOX if focus == "panel" else CHAT_BOX
        return main, ocr_region(png, box, self.scale, extra_zoom=2)

    def _click_by_name(self, main: dict, name: str, lines: list[dict]) -> bool:
        """点开会话项。严格限定：只在左侧面板的会话项区域（x 0.045~0.23W）内点击，
        绝不触碰左侧图标导航条（x < 0.045W）——实测误点导航会把客户端带离客服模块。"""
        W, H = image_size(main, self.scale)
        for ln in lines:
            cx = _cx(ln)
            if (ln["text"].strip() == name
                    and 0.045 * W <= cx <= 0.23 * W
                    and _in_left(ln, W, H)):
                rel_x = cx / self.scale
                rel_y = _cy(ln) / self.scale
                return click_at(int(main["rect"]["left"] + rel_x),
                                int(main["rect"]["top"] + rel_y), main)
        return False

    def read_once(self, only_changed: bool = True, log=print) -> dict:
        import ctypes as _ct
        user32_fg = _ct.windll.user32
        user32_fg.GetForegroundWindow.restype = _ct.c_void_p
        fg_before = user32_fg.GetForegroundWindow()
        try:
            return self._read_once_inner(only_changed, log)
        finally:
            # 读取过程会把客户端提到前台（拿实时画面/点击需要），结束后还原用户的前台窗口。
            # ⚠️ 句柄必须用 c_void_p 传：裸 int 按 32 位转换，句柄大数值时
            # 报 "argument 1: OverflowError: int too long to convert"（实测踩过）。
            if fg_before:
                try:
                    user32_fg.SetForegroundWindow(_ct.c_void_p(fg_before))
                except Exception:  # noqa: BLE001
                    pass

    def _read_once_inner(self, only_changed: bool = True, log=print) -> dict:
        main, lines = self._snapshot(focus="panel")
        W, H = image_size(main, self.scale)
        panel = parse_cs_panel(lines, W, H)
        groups = panel["groups"]
        log("分组: " + ", ".join(f"{g['label']}·{g['count']}" for g in groups)
            + (f"（{len(groups)} 个分组）" if groups else "（未解析到分组）"))

        pending = [g for g in groups if g["count"] > 0]
        if not groups:
            # 关键保护：识别不到客服面板（可能被切到别的模块）时**不做任何点击**，
            # 早前版本会在这种状态下误点导航图标，把客户端带离客服模块。
            log("未识别到客服分组面板（可能不在客服模块），本轮跳过、不点击")
            return {"groups": [], "newMessages": []}
        if not pending:
            log("当前没有待处理会话（所有分组计数为 0）")
            self.last_group_state = {g["label"]: g["count"] for g in groups}
            return {"groups": [{k: g[k] for k in ("label", "count")} for g in groups],
                    "newMessages": []}

        new_messages: list[dict] = []
        for grp in pending:
            for item in grp["items"]:
                key = item["name"]
                state = (grp["label"], item.get("preview"))
                if only_changed and self.last_item_state.get(key) == state:
                    continue
                self.last_item_state[key] = state
                if not self._click_by_name(main, item["name"], lines):
                    log(f"  跳过 {key!r}: 面板中未定位到（可能名字含标签被拆分）")
                    continue
                time.sleep(1.5)
                main2, lines2 = self._snapshot(focus="chat")
                W2, H2 = image_size(main2, self.scale)
                # 行式解析 + 文本过滤：飞桨文本干净（无逐字空格/粘连），
                # 配合元数据/横幅黑名单即可得到干净消息（气泡版面识别保留备用）
                parsed = parse_middle_chat(lines2, W2, H2)
                apply_direction_by_color(os.path.join(OUT_DIR, "pdd_capture.png"),
                                         parsed["messages"], self.scale)
                title = masked_customer_name(read_conversation_title(main2, self.scale))
                key = title or parsed.get("title") or item["name"]
                if key not in self.initialized:
                    # 用户约定：新客户第一次从最上面完整读一遍；之后每轮只核当前页
                    try:
                        backfilled = self._initial_backfill(main2, key, title or item["name"])
                        for m in backfilled:
                            self.seen.add(m["fp"])
                            new_messages.append({
                                "conversationKey": key, "conversationName": key,
                                "direction": m["direction"], "timeText": m["timeText"],
                                "clientTimestamp": to_iso_time(m["timeText"]) if m["timeText"] else "",
                                "text": m["text"], "fingerprint": m["fp"]})
                        log(f"  {key}: 首次见到，已从最顶部完整回翻 {len(backfilled)} 条")
                    except Exception as exc:  # noqa: BLE001
                        log(f"  {key}: 首次回翻失败({type(exc).__name__}: {exc})，按当前页起算")
                    self.initialized.add(key)
                counters: dict[tuple, int] = {}
                fresh = 0
                for msg in parsed["messages"]:
                    token = (msg["direction"], msg["timeText"], msg["text"])
                    occurrence = counters.get(token, 0)
                    counters[token] = occurrence + 1
                    fp = fingerprint(key, msg["direction"], msg["timeText"],
                                     msg["text"], occurrence)
                    if fp in self.seen:
                        continue
                    self.seen.add(fp)
                    fresh += 1
                    new_messages.append({
                        "conversationKey": f"pdd:{key}",
                        "conversationName": key,
                        "direction": msg["direction"],
                        "timeText": msg["timeText"],
                        "clientTimestamp": to_iso_time(msg["timeText"]) if msg["timeText"] else "",
                        "text": msg["text"],
                        "fingerprint": fp,
                    })
                log(f"  {key}: 解析 {len(parsed['messages'])} 条，新增 {fresh} 条")
        self.last_group_state = {g["label"]: g["count"] for g in groups}
        return {"groups": [{k: g[k] for k in ("label", "count")} for g in groups],
                "newMessages": new_messages}


def cmd_once(args) -> int:
    ensure_dpi_aware()
    reader = PddChatReader(scale=args.scale)
    result = reader.read_once(only_changed=args.only_changed)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
        print(f"-> {args.json}")
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    parser = argparse.ArgumentParser(description="拼多多客服模块聊天读取器")
    parser.add_argument("command", choices=["once"])
    parser.add_argument("--json", default=None)
    parser.add_argument("--scale", type=int, default=2)
    parser.add_argument("--only-changed", action="store_true")
    args = parser.parse_args()
    if args.command == "once":
        return cmd_once(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
