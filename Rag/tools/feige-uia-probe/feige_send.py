#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把文字发送到飞鸽当前会话（写操作）。

机制：
  写入：ValuePattern.SetValue 写输入框 → 回读校验
  发送：LegacyIAccessiblePattern.DoDefaultAction 触发"发送"（**不激活窗口**）
        —— 详见 trigger_send_button() 的说明，别改回 Invoke()。
不用 SendKeys 回车：键盘注入会抢前台，且按键会送到当前焦点所在窗口，有误击风险。

安全设计（发送不可撤回，所以每一步都先验证再动手）
----------------------------------------------------
1. **会话校验**：发送前先算当前会话的客户键，与指令里的 targetUserId 比对。
   不一致直接拒绝 —— 操作员在客户端里切了会话却从程序端发送，会发给错的客户。
2. **写入后回读**：输入框内容与目标不一致就不点发送。
3. **发送后确认输入框已清空**：没清空说明没发出去，如实报失败而不是谎报成功。
4. 单次执行，不自动重试。
"""

from __future__ import annotations

import os
import sys
import time
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

INPUT_AID = "im-input-box"
SEND_LABEL = "发送"


def _try_value_pattern(control):
    """直接取 ValuePattern 并检查 IsReadOnly。

    不要用 IsValuePatternAvailable()：实测该系列方法在本机 Chromium 上返回 None
    （调用失败），据此判断会把实际可写的输入框误判成不可写。
    """
    try:
        pattern = control.GetValuePattern()
    except Exception:
        return None, True
    try:
        return pattern, bool(pattern.IsReadOnly)
    except Exception:
        return pattern, True


def _try_invoke(control) -> bool:
    try:
        control.GetInvokePattern()
        return True
    except Exception:
        return False


def _has_default_action(control) -> bool:
    """控件是否提供无障碍"默认动作"（不激活窗口的触发方式）。"""
    try:
        return control.GetLegacyIAccessiblePattern() is not None
    except Exception:
        return False


def write_text(control, value: str) -> tuple:
    """把文字写进输入框，返回 (mechanism, error_message)。

    ⚠️ **抢焦点的真正来源是"写入"，不是"点发送"**（实测）
    ---------------------------------------------------
    最初的判断是 `InvokePattern.Invoke()` 把窗口拉到前台，所以只换发送触发器。
    实测逐段量了一遍前台窗口（把前台先挪到别的窗口，再看每一步之后是谁）：

        resolve_render_host   -> 不变
        find_input_box        -> 不变
        ValuePattern.SetValue -> **飞鸽变成前台窗口**（就是这一步）
        DoDefaultAction       -> 不变（窗口已经是前台了）

    也就是说 `ValuePattern.SetValue` 自己就会激活窗口。只换触发器解决不了问题。

    改用 `LegacyIAccessiblePattern.SetValue` 实测**不激活窗口**，且文字确实
    写进了输入框（回读一致）。它走的是无障碍 Value 设置，不触发 Chromium
    那套"设置值 → 元素获得焦点 → 窗口提升"的逻辑。
    """
    # 1) 无障碍 SetValue（实测不激活窗口）
    try:
        pattern = control.GetLegacyIAccessiblePattern()
    except Exception:
        pattern = None
    if pattern is not None:
        try:
            if pattern.SetValue(value):
                return 'legacy_set_value', None
            legacy_error = '无障碍 SetValue 返回失败'
        except Exception as exc:  # noqa: BLE001
            legacy_error = str(exc)[:160]
    else:
        legacy_error = '控件未提供无障碍 SetValue'

    # 2) 兜底 ValuePattern.SetValue —— **会把飞鸽窗口拉到前台**，
    #    返回值里的 mechanism 会如实标成 value_pattern，日志可查。
    vp, read_only = _try_value_pattern(control)
    if vp is None or read_only:
        return None, f'{legacy_error}；ValuePattern 也不可写'
    try:
        vp.SetValue(value)
        return 'value_pattern', None
    except Exception as exc:  # noqa: BLE001
        return None, f'{legacy_error}；ValuePattern 写入失败: {str(exc)[:120]}'


def trigger_send_button(control) -> tuple:
    """触发发送按钮，返回 (mechanism, error_message)。

    优先使用**不激活窗口**的方式：

    1. `LegacyIAccessiblePattern.DoDefaultAction` —— 无障碍默认动作。
       在 Chromium 里它由渲染进程执行 DOM click，不注入系统鼠标事件、
       也不提升窗口（实测：窗口非前台时调用它，前台窗口不变）。
    2. `InvokePattern.Invoke` —— **已知会抢焦点**，仅作为兜底。
       Chromium 的 UIA Invoke 内部模拟真实点击（含窗口激活），会把飞鸽
       窗口拉到前台、打断操作员正在做的事。所以它能不用就不用；
       真走到这一步时，返回值里的 mechanism 会写成 'invoke'，日志可查。

    ⚠️ 不要用 `Control.Click()` 或 `SendKeys` 兜底：前者移动真实光标并注入
    鼠标事件，后者把按键送给当前焦点窗口，两者都会抢前台且可能误击。
    """
    # 1) 无障碍默认动作（不激活窗口）
    try:
        pattern = control.GetLegacyIAccessiblePattern()
    except Exception:
        pattern = None
    if pattern is not None:
        try:
            if pattern.DoDefaultAction():
                return 'default_action', None
            default_action_error = '无障碍默认动作返回失败'
        except Exception as exc:  # noqa: BLE001
            default_action_error = str(exc)[:200]
    else:
        default_action_error = '控件未提供无障碍默认动作'

    # 2) 兜底：InvokePattern（会抢焦点，mechanism 会如实标成 invoke）
    try:
        control.GetInvokePattern().Invoke()
        return 'invoke', None
    except Exception as exc:  # noqa: BLE001
        return None, f'{default_action_error}；Invoke 也不可用: {str(exc)[:120]}'


def _descendants(control):
    stack = [control]
    while stack:
        node = stack.pop(0)
        yield node
        try:
            children = node.GetChildren() or []
        except Exception:
            children = []
        stack.extend(children)


def _rect_area(control) -> int:
    try:
        rect = control.BoundingRectangle
        return int(rect.width() or 0) * int(rect.height() or 0)
    except Exception:
        return 10 ** 9


def _safe_name(control) -> str:
    try:
        return (control.Name or "").strip()
    except Exception:
        return ""


def find_input_box():
    """按 automation_id 定位输入框容器。"""
    import uiautomation as auto
    from feige_extract import resolve_render_host, safe

    host = resolve_render_host()
    found = []

    def walk(node, depth):
        if depth > 45 or found:
            return
        if (safe(lambda: node.AutomationId, "") or "") == INPUT_AID:
            found.append(node)
            return
        for child in safe(lambda: node.GetChildren(), []) or []:
            walk(child, depth + 1)
            if found:
                return

    walk(host["control"], 0)
    return host, (found[0] if found else None)


def current_customer_key() -> Optional[str]:
    """当前会话的客户键，派生方式必须与入站上报时一致（bridge_node.build_inbound）。

    客户键取自**顶栏** `topbar-left-info`（`current_customer`），与节点采集入站时
    用的是同一个函数、同一套公式（`digest12(店铺|digest12(昵称))`）。

    不要改回按会话列表（`extract_conversation_list`）取：那条路径与入站不一致。
    实测会话列表容器为空时它直接返回 None，于是发送被 `NO_OPEN_CONVERSATION`
    挡下——而此时顶栏读得完全正常（后端 `AccountSnapshot` 还在正常上报当前会话），
    表现为"客户端明明开着会话却发不出去"。
    """
    from feige_extract import build_tree, current_customer, resolve_render_host

    host = resolve_render_host()
    tree = build_tree(host["control"])
    shop_name = host["shop_title"].replace("[商家]", "").strip()
    customer = current_customer(tree, shop_name) or {}
    return customer.get("customerKey") or None


def send_text(text: str, expect_customer_key: Optional[str] = None) -> dict:
    """发送一条文本。返回 {ok, code, detail}。"""
    text = (text or "").strip()
    if not text:
        return {"ok": False, "code": "EMPTY_CONTENT", "detail": "内容为空"}

    # 1) 会话校验：先确认客户端里打开的就是目标客户
    if expect_customer_key:
        try:
            current = current_customer_key()
        except SystemExit as exc:
            return {"ok": False, "code": "CLIENT_UNAVAILABLE", "detail": str(exc)[:200]}
        if not current:
            return {"ok": False, "code": "NO_OPEN_CONVERSATION",
                    "detail": "客户端里没有打开任何会话"}
        if current != expect_customer_key:
            return {
                "ok": False,
                "code": "CUSTOMER_MISMATCH",
                "detail": "客户端当前打开的会话与目标客户不一致，已拒绝发送以防发错人"
                          "（请在飞鸽里切回该客户再重试）"
            }

    # 2) 定位输入框与发送按钮
    try:
        _host, box = find_input_box()
    except SystemExit as exc:
        return {"ok": False, "code": "CLIENT_UNAVAILABLE", "detail": str(exc)[:200]}
    if box is None:
        return {"ok": False, "code": "INPUT_NOT_FOUND", "detail": f"未找到 {INPUT_AID}"}

    edit = None
    for child in _descendants(box):
        pattern, read_only = _try_value_pattern(child)
        if pattern is not None and not read_only:
            edit = child
            break
    if edit is None:
        return {"ok": False, "code": "INPUT_NOT_WRITABLE",
                "detail": "输入框没有可写的编辑控件"}

    # 发送按钮：排除容器本身（im-input-box 的名字也含"发 送"），
    # 名字去空格后精确等于"发送"，取面积最小的那个。
    # 触发器只要能用默认动作或 Invoke 之一即可——默认动作才是我们要用的那个，
    # 但候选筛选不能只看 Invoke，否则哪天 Chromium 不再暴露 Invoke 就找不到按钮了。
    candidates = []
    for child in _descendants(box):
        if child is box:
            continue
        if _safe_name(child).replace(" ", "") != SEND_LABEL:
            continue
        if not (_has_default_action(child) or _try_invoke(child)):
            continue
        candidates.append((_rect_area(child), child))
    send_button = min(candidates, key=lambda item: item[0])[1] if candidates else None

    # 3) 写入并回读校验
    # 回读仍用 ValuePattern：无障碍 SetValue 写进去的值，ValuePattern 读得到
    # （实测一致），所以这套"换写入方式但回读不变"的校验依然成立。
    pattern, _ = _try_value_pattern(edit)
    write_mechanism, write_error = write_text(edit, text)
    if write_mechanism is None:
        return {"ok": False, "code": "SET_VALUE_FAILED", "detail": write_error}
    time.sleep(0.4)

    try:
        actual = (pattern.Value or "").strip()
    except Exception:
        actual = _safe_name(edit)
    if actual != text:
        return {"ok": False, "code": "READBACK_MISMATCH",
                "detail": f"写入后回读不一致（期望 {len(text)} 字，实际 {len(actual)} 字），已中止不发送"}

    # 4) 发送
    if send_button is not None:
        mechanism, trigger_error = trigger_send_button(send_button)
        if mechanism is None:
            return {"ok": False, "code": "SEND_TRIGGER_FAILED", "detail": trigger_error}
    else:
        return {"ok": False, "code": "SEND_BUTTON_NOT_FOUND",
                "detail": "未找到发送按钮，为安全起见不使用回车键兜底"}

    # 5) 确认输入框已清空
    time.sleep(1.2)
    try:
        remaining = (pattern.Value or "").strip()
    except Exception:
        remaining = ""
    if remaining:
        return {"ok": False, "code": "NOT_SENT",
                "detail": f"点击发送后输入框仍有 {len(remaining)} 字，消息可能未发出"}

    # detail 里同时报出写入与触发各用了哪种机制：'legacy_set_value' / 'default_action'
    # 才是不抢焦点的组合；一旦出现 value_pattern / invoke，说明退回了会抢焦点的兜底路径。
    return {"ok": True, "code": "SENT", "detail": f"{write_mechanism}+{mechanism}"}


if __name__ == "__main__":
    import argparse
    import json

    # 默认**什么也不做**。
    # 教训：最初这里写成 `target = argv[1] or "测试消息"`，结果 `--check` 被当成
    # 消息内容直接发给了真实客户（真实发生过）。凡是会把内容发给真人的脚本，
    # 默认动作必须是只读，发送要显式加 --send。
    parser = argparse.ArgumentParser(
        description="飞鸽发送（默认只读；真正发送必须显式 --send）")
    parser.add_argument("--check", action="store_true",
                        help="只打印当前会话的客户键，不做任何写入")
    parser.add_argument("--send", metavar="TEXT", default=None,
                        help="真正发送 TEXT（不可撤回），建议同时用 --expect 校验会话")
    parser.add_argument("--expect", metavar="CUSTOMER_KEY", default=None,
                        help="发送前校验当前会话的客户键，不一致则拒绝")
    args = parser.parse_args()

    if args.check:
        print(json.dumps({"currentCustomerKey": current_customer_key()}, ensure_ascii=False))
    elif args.send is not None:
        print(json.dumps(send_text(args.send, expect_customer_key=args.expect),
                         ensure_ascii=False))
    else:
        parser.print_help()
        print("\n未指定动作，未做任何操作。", file=sys.stderr)
