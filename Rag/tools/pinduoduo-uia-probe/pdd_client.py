#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""拼多多工作台客户端：窗口截图 + Windows OCR 读取（视觉方案）。

背景
----
该客户端的定制 Chromium 内核（pddbrowser104）不提供 UI Automation 无障碍树
（UIA 不可读，见 REPORT-pinduoduo-uia.md），读取走"截图 + OCR"：

- **截图**：`PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)` —— 实测可用，
  **窗口被其他窗口遮挡也能截**，不需要置顶、不抢前台；
- **OCR**：Windows 自带 `Windows.Media.Ocr`（zh-Hans-CN），输出每行文本 +
  屏幕坐标（坐标可用于后续的点击定位）；
- **编码坑**：PowerShell 5.1 接收 WinRT 字符串会经 ANSI 代码页损坏
  （UTF-8 字节被按 GBK 解读），必须在调起 PS 时先 `chcp 65001`（实测修复）。

只读保证：不点击、不输入、不注入进程、不改窗口状态；仅读屏与本地 OCR。

用法
----
  python pdd_client.py capture [--out out/pdd_capture.png] [--scale 2]
  python pdd_client.py read [--scale 2] [--json out/pdd_read.json]

  read 会把识别到的文本行（带坐标）打印出来；--json 另存结构化结果。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import subprocess
import sys
import tempfile
import time
from ctypes import wintypes
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")
OCR_SCRIPT = os.path.join(HERE, "ocr.ps1")

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

# 显式声明签名：缺 restype 时 ctypes 按 32 位 c_int 处理 64 位句柄，
# 句柄数值超过 32 位范围时报 "argument 1: OverflowError: int too long to convert"
# （实测偶发坑：GetWindowDC 的 HDC 传给 CreateCompatibleBitmap 时触发）。
_c_void_p = ctypes.c_void_p
user32.GetWindowDC.restype = _c_void_p
user32.GetWindowDC.argtypes = [wintypes.HWND]
user32.PrintWindow.restype = wintypes.BOOL
user32.PrintWindow.argtypes = [wintypes.HWND, _c_void_p, wintypes.UINT]
user32.ReleaseDC.argtypes = [wintypes.HWND, _c_void_p]
user32.GetForegroundWindow.restype = wintypes.HWND
user32.WindowFromPoint.restype = wintypes.HWND
user32.WindowFromPoint.argtypes = [wintypes.POINT]
user32.GetAncestor.restype = wintypes.HWND
user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
gdi32.CreateCompatibleDC.restype = _c_void_p
gdi32.CreateCompatibleDC.argtypes = [_c_void_p]
gdi32.CreateCompatibleBitmap.restype = _c_void_p
gdi32.CreateCompatibleBitmap.argtypes = [_c_void_p, ctypes.c_int, ctypes.c_int]
gdi32.SelectObject.restype = _c_void_p
gdi32.SelectObject.argtypes = [_c_void_p, _c_void_p]
gdi32.GetDIBits.restype = ctypes.c_int
gdi32.GetDIBits.argtypes = [_c_void_p, _c_void_p, wintypes.UINT, wintypes.UINT,
                            ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT]
gdi32.DeleteObject.argtypes = [_c_void_p]
gdi32.DeleteDC.argtypes = [_c_void_p]

MAIN_WINDOW_CLASS_PREFIX = "g_wszPDDWindowClass"
PROCESS_HINTS = ("PddWorkbench.exe", "pddwebworkbench.exe", "PDDWBGd.exe")
PW_RENDERFULLCONTENT = 0x00000002


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_long),
                ("biHeight", ctypes.c_long), ("biPlanes", ctypes.c_ushort),
                ("biBitCount", ctypes.c_ushort), ("biCompression", ctypes.c_uint32),
                ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_long),
                ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", ctypes.c_uint32),
                ("biClrImportant", ctypes.c_uint32)]


def ensure_dpi_aware() -> None:
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:  # noqa: BLE001
        pass


def process_name(pid: int) -> str:
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return "?"
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value)
        return "?"
    finally:
        kernel32.CloseHandle(handle)


def find_main_window() -> Optional[dict]:
    """找当前可见的拼多多工作台主窗口（含 pid）。"""
    found: list[dict] = []
    EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _lparam):
        buf = ctypes.create_unicode_buffer(512)
        user32.GetClassNameW(wintypes.HWND(hwnd), buf, 512)
        if not buf.value.startswith(MAIN_WINDOW_CLASS_PREFIX):
            return True
        if not user32.IsWindowVisible(wintypes.HWND(hwnd)):
            return True
        rect = RECT()
        user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect))
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(pid))
        found.append({
            "hwnd": int(hwnd),
            "pid": int(pid.value),
            "rect": {"left": rect.left, "top": rect.top,
                     "width": rect.right - rect.left, "height": rect.bottom - rect.top},
        })
        return True

    user32.EnumWindows(EnumProc(cb), 0)
    return found[0] if found else None


def point_root_pid(x: int, y: int) -> int:
    """屏幕点 (x,y) 处最顶层窗口的根窗口所属进程 id。"""
    hwnd = user32.WindowFromPoint(wintypes.POINT(x, y))
    if not hwnd:
        return 0
    root = user32.GetAncestor(wintypes.HWND(hwnd), 2)  # GA_ROOT
    if not root:
        return 0
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(wintypes.HWND(root), ctypes.byref(pid))
    return int(pid.value)


def raise_window(hwnd: int) -> bool:
    """把目标窗口提到前台（点击/输入前必须确保目标没有被其他窗口盖住）。"""
    if user32.SetForegroundWindow(wintypes.HWND(hwnd)):
        return True
    flags = 0x0001 | 0x0002 | 0x0040  # NOSIZE | NOMOVE | SHOWWINDOW
    ok = user32.SetWindowPos(wintypes.HWND(hwnd), wintypes.HWND(-1), 0, 0, 0, 0, flags)
    user32.SetWindowPos(wintypes.HWND(hwnd), wintypes.HWND(-2), 0, 0, 0, 0, flags)
    return bool(ok)


# ---- 键盘输入（SendInput，Unicode 直写，不依赖输入法） ----

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
VK_RETURN = 0x0D


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort),
                ("dwFlags", ctypes.c_uint32), ("time", ctypes.c_uint32),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long),
                ("mouseData", ctypes.c_uint32), ("dwFlags", ctypes.c_uint32),
                ("time", ctypes.c_uint32), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", _KEYBDINPUT), ("mi", _MOUSEINPUT)]


class _INPUT(ctypes.Structure):
    _fields_ = [("type", ctypes.c_uint32), ("u", _INPUTUNION)]


def _send_keyboard_inputs(inputs: list) -> bool:
    if not inputs:
        return False
    arr = (_INPUT * len(inputs))(*inputs)
    sent = user32.SendInput(len(inputs), ctypes.byref(arr), ctypes.sizeof(_INPUT))
    return sent == len(inputs)


def send_unicode_text(text: str) -> bool:
    """按 Unicode 逐字发送（wScan=字符码，KEYEVENTF_UNICODE），中文无需输入法。"""
    inputs = []
    for ch in text:
        code = ord(ch)
        if code > 0xFFFF:
            continue  # BMP 之外暂不支持
        for flags in (KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP):
            inputs.append(_INPUT(type=INPUT_KEYBOARD,
                                 u=_INPUTUNION(ki=_KEYBDINPUT(0, code, flags, 0, None))))
    return _send_keyboard_inputs(inputs)


def send_vk(vk: int) -> bool:
    down = _INPUT(type=INPUT_KEYBOARD, u=_INPUTUNION(ki=_KEYBDINPUT(vk, 0, 0, 0, None)))
    up = _INPUT(type=INPUT_KEYBOARD,
                u=_INPUTUNION(ki=_KEYBDINPUT(vk, 0, KEYEVENTF_KEYUP, 0, None)))
    return _send_keyboard_inputs([down, up])


def click_at(screen_x: int, screen_y: int, main: dict) -> bool:
    """点击屏幕坐标前先确认该点属于拼多多客户端（被遮挡则提窗），并做坐标合法性保护。"""
    if not (0 < screen_x < 30000 and 0 < screen_y < 30000):
        print(f"坐标越界，拒绝点击: ({screen_x},{screen_y})")
        return False
    root_pid = point_root_pid(screen_x, screen_y)
    if root_pid != main["pid"]:
        print(f"目标点被其他窗口(pid={root_pid})遮挡，提窗后重试…")
        raise_window(main["hwnd"])
        time.sleep(1.0)
        if point_root_pid(screen_x, screen_y) != main["pid"]:
            print("提窗后目标点仍不属于拼多多客户端，放弃")
            return False
    user32.SetCursorPos(screen_x, screen_y)
    time.sleep(0.15)
    user32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
    time.sleep(0.05)
    user32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    return True


def capture_window(hwnd: int):
    """PrintWindow 截图（遮挡可截），返回 PIL.Image。"""
    from PIL import Image

    rect = RECT()
    if not user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect)):
        raise RuntimeError("GetWindowRect 失败")
    w, h = rect.right - rect.left, rect.bottom - rect.top
    if w <= 0 or h <= 0 or w > 6000 or h > 4000:
        raise RuntimeError(f"窗口尺寸异常: {w}x{h}")

    hwnd_dc = user32.GetWindowDC(wintypes.HWND(hwnd))
    mem_dc = gdi32.CreateCompatibleDC(hwnd_dc)
    bmp = gdi32.CreateCompatibleBitmap(hwnd_dc, w, h)
    gdi32.SelectObject(mem_dc, bmp)
    try:
        if not user32.PrintWindow(wintypes.HWND(hwnd), mem_dc, PW_RENDERFULLCONTENT):
            raise RuntimeError("PrintWindow 失败")
        bi = BITMAPINFOHEADER()
        bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bi.biWidth = w
        bi.biHeight = -h
        bi.biPlanes = 1
        bi.biBitCount = 32
        bi.biCompression = 0
        buf = ctypes.create_string_buffer(w * h * 4)
        gdi32.GetDIBits(mem_dc, bmp, 0, h, buf, ctypes.byref(bi), 0)
        return Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB")
    finally:
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(wintypes.HWND(hwnd), hwnd_dc)


def ocr_image(png_path: str) -> list[dict]:
    """调 PowerShell OCR（chcp 65001 修复 WinRT 字符串编码），返回行列表。

    ⚠️ 入参必须是绝对路径：WinRT 的 StorageFile.GetFileFromPathAsync 不接受相对路径
    （相对路径会报 "Wait 时发生异常"，极易被误判成 OCR 引擎故障）。这里统一转换。
    """
    png_path = os.path.abspath(png_path)
    # 优先 PaddleOCR（百度飞桨，中文质量显著更好）；不可用时回退 Windows OCR
    try:
        from pdd_paddle import paddle_ocr_lines
        return paddle_ocr_lines(png_path)
    except Exception as exc:  # noqa: BLE001
        print(f"[ocr] PaddleOCR 不可用，回退 Windows OCR：{type(exc).__name__}: {exc}")
    json_path = png_path + ".ocr.json"
    command = (
        "chcp 65001 | Out-Null; "
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
        f"& '{OCR_SCRIPT}' -Path '{png_path}' -OutPath '{json_path}'"
    )
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    if proc.returncode != 0 or not os.path.exists(json_path):
        raise RuntimeError(f"OCR 失败: {(proc.stderr or proc.stdout or '')[:300]}")
    with open(json_path, encoding="utf-8") as fh:
        data = json.load(fh)
    return data.get("lines", [])


def normalize_text(text: str) -> str:
    """Windows OCR 对中日韩文字会逐字用空格分隔，这里去掉字间空格。"""
    if not text:
        return ""
    if " " in text:
        stripped = text.replace(" ", "")
        # 纯 ASCII 行（如英文单词/数字）不要粘连，保留原样
        if any("\u4e00" <= ch <= "\u9fff" for ch in stripped):
            return stripped
    return text


def cmd_capture(args) -> int:
    ensure_dpi_aware()
    main = find_main_window()
    if main is None:
        print("未找到可见的拼多多工作台主窗口")
        return 3
    img = capture_window(main["hwnd"])
    if args.scale != 1:
        from PIL import Image
        img = img.resize((img.width * args.scale, img.height * args.scale), Image.LANCZOS)
    os.makedirs(OUT_DIR, exist_ok=True)
    out = args.out or os.path.join(OUT_DIR, "pdd_capture.png")
    img.save(out)
    print(f"已截图: {out} ({img.width}x{img.height}, 窗口 hwnd={main['hwnd']})")
    return 0


def capture_and_ocr(main: dict, scale: int, ensure_fresh: bool = True,
                    do_ocr: bool = True) -> list[dict]:
    """截图（PrintWindow）+ OCR，返回按坐标排序的文本行。png 存 out/pdd_capture.png。

    ⚠️ 前台校验（2026-10-13 踩坑）：客户端窗口不在前台时，Chromium 会停止渲染，
    PrintWindow 拿到的是**停更的旧帧**——对"刚操作完马上核对"的场景会读到过期状态
    （实测：回车发送后截图仍显示输入框有字，实际消息已发出，导致重复发送）。
    因此默认先确保窗口在前台；纯观察且不在意新鲜度时可用 --no-raise 跳过。
    """
    if ensure_fresh and user32.GetForegroundWindow() != main["hwnd"]:
        print("窗口不在前台（后台时截图可能是旧帧），提窗后截取…")
        raise_window(main["hwnd"])
        time.sleep(0.8)
    img = capture_window(main["hwnd"])
    if scale != 1:
        from PIL import Image
        img = img.resize((img.width * scale, img.height * scale), Image.LANCZOS)
    os.makedirs(OUT_DIR, exist_ok=True)
    png = os.path.join(OUT_DIR, "pdd_capture.png")
    img.save(png)
    if not do_ocr:
        return []
    lines = ocr_image(png)
    for ln in lines:
        ln["text"] = normalize_text(ln["text"])
    lines.sort(key=lambda l: (l["y"], l["x"]))
    return lines


def cmd_read(args) -> int:
    ensure_dpi_aware()
    main = find_main_window()
    if main is None:
        print("未找到可见的拼多多工作台主窗口")
        return 3
    lines = capture_and_ocr(main, args.scale, ensure_fresh=not args.no_raise)

    print(f"=== OCR 读取 {len(lines)} 行（窗口 hwnd={main['hwnd']}, 缩放 {args.scale}x）===")
    for ln in lines:
        print(f"  ({ln['x']:>4},{ln['y']:>4}) w={ln['width']:>4} | {ln['text']}")
    if args.json:
        payload = {"capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                   "windowRect": main["rect"], "scale": args.scale, "lines": lines}
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        print(f"-> {args.json}")
    return 0


def cmd_click_text(args) -> int:
    """在当前屏幕上找到包含指定文字的行，点击其中心（坐标每次实时计算，不写死）。"""
    ensure_dpi_aware()
    main = find_main_window()
    if main is None:
        print("未找到可见的拼多多工作台主窗口")
        return 3
    lines = capture_and_ocr(main, args.scale, ensure_fresh=not args.no_raise)
    matches = [ln for ln in lines if args.text and args.text in ln["text"]]
    if not matches:
        print(f"当前屏幕未找到包含 {args.text!r} 的文字。识别到的行：")
        for ln in lines:
            print(f"  ({ln['x']},{ln['y']}) {ln['text']}")
        return 4
    if len(matches) > 1 and args.pick is None:
        print(f"匹配到 {len(matches)} 处，用 --pick 指定序号（从 0 开始）：")
        for i, ln in enumerate(matches):
            print(f"  [{i}] ({ln['x']},{ln['y']}) {ln['text']}")
        return 5
    target = matches[args.pick or 0]
    rel_x = (target["x"] + target["width"] / 2) / args.scale
    rel_y = (target["y"] + target["height"] / 2) / args.scale
    screen_x = int(main["rect"]["left"] + rel_x)
    screen_y = int(main["rect"]["top"] + rel_y)
    print(f"目标: {target['text']!r} 窗口相对({rel_x:.0f},{rel_y:.0f}) → 屏幕({screen_x},{screen_y})")
    if not click_at(screen_x, screen_y, main):
        return 6
    print("已点击。确认效果请再执行 read。")
    return 0


def cmd_click_input(args) -> int:
    """点击聊天输入框（按窗口几何定位：聊天区底部大输入框，比例 0.42×宽度、0.86×高度）。"""
    ensure_dpi_aware()
    main = find_main_window()
    if main is None:
        print("未找到可见的拼多多工作台主窗口")
        return 3
    rect = main["rect"]
    screen_x = int(rect["left"] + rect["width"] * 0.42)
    screen_y = int(rect["top"] + rect["height"] * 0.86)
    print(f"点击输入框: 屏幕({screen_x},{screen_y})")
    if not click_at(screen_x, screen_y, main):
        return 6
    print("已点击输入框（焦点应在输入框内）")
    return 0


def cmd_type_text(args) -> int:
    """向当前焦点输入文本（SendInput Unicode；请先用 click-input 聚焦输入框）。"""
    ensure_dpi_aware()
    if not args.text:
        print("需要 --text")
        return 2
    ok = send_unicode_text(args.text)
    print(f"已发送 {len(args.text)} 个字符到焦点控件: {ok}")
    return 0 if ok else 6


def cmd_press_enter(_args) -> int:
    ensure_dpi_aware()
    ok = send_vk(VK_RETURN)
    print(f"已按回车: {ok}")
    return 0 if ok else 6


def cmd_click_point(args) -> int:
    """按窗口相对坐标点击（x/y 为 1x 窗口内坐标；点击前自动做遮挡检查）。"""
    ensure_dpi_aware()
    main = find_main_window()
    if main is None:
        print("未找到可见的拼多多工作台主窗口")
        return 3
    if args.x is None or args.y is None:
        print("需要 --x 和 --y（窗口内坐标）")
        return 2
    rect = main["rect"]
    screen_x = int(rect["left"] + args.x)
    screen_y = int(rect["top"] + args.y)
    print(f"点击窗口相对({args.x},{args.y}) → 屏幕({screen_x},{screen_y})")
    if not click_at(screen_x, screen_y, main):
        return 6
    print("已点击。")
    return 0


def main() -> int:
    # 中文输出不受控制台代码页影响（文件数据本身与显示编码无关，这里统一 stdout）
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    parser = argparse.ArgumentParser(description="拼多多工作台截图+OCR 读取（只读）")
    parser.add_argument("command", choices=["capture", "read", "click-text",
                                            "click-input", "click-point", "type-text", "press-enter"])
    parser.add_argument("--out", default=None, help="capture 输出路径")
    parser.add_argument("--json", default=None, help="read 结构化输出路径")
    parser.add_argument("--scale", type=int, default=2, help="截图放大倍数（提升小字识别率）")
    parser.add_argument("--text", default=None, help="click-text/type-text: 目标文字 / 要输入的文本")
    parser.add_argument("--pick", type=int, default=None, help="click-text: 多匹配时选第几个（从 0 开始）")
    parser.add_argument("--x", type=int, default=None, help="click-point: 窗口内 x")
    parser.add_argument("--y", type=int, default=None, help="click-point: 窗口内 y")
    parser.add_argument("--no-raise", action="store_true",
                        help="读取前不提窗（窗口在后台时截图可能是旧帧，谨慎使用）")
    args = parser.parse_args()
    if args.command == "capture":
        return cmd_capture(args)
    if args.command == "click-text":
        return cmd_click_text(args)
    if args.command == "click-input":
        return cmd_click_input(args)
    if args.command == "click-point":
        return cmd_click_point(args)
    if args.command == "type-text":
        return cmd_type_text(args)
    if args.command == "press-enter":
        return cmd_press_enter(args)
    return cmd_read(args)


if __name__ == "__main__":
    raise SystemExit(main())
