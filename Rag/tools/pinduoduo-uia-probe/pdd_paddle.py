#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PaddleOCR（百度飞桨）引擎封装 —— 与 Windows OCR 同接口，中文识别质量显著更好。

- 单例复用（模型初始化 ~20s，只做一次）；
- 已知兼容坑：PaddlePaddle 3.x 的 oneDNN 后端在部分 CPU 上报
  "ConvertPirAttribute2RuntimeAttribute not support"，关掉 mkldnn 即可；
- 返回 [{x, y, width, height, text, confidence}]（图像坐标，按行排序）。
"""

from __future__ import annotations

import os
import threading

os.environ.setdefault("FLAGS_use_mkldnn", "0")
# 模型/缓存放项目目录，不占 C 盘（PaddleX 3.x 用 PADDLE_PDX_CACHE_HOME 指定缓存根）
_cache_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "paddlex_home")
# ⚠️ 飞桨 C++ 层在**非 ASCII 路径**下读模型会失败（报空 JSON parse error）。
# 项目路径含中文（E:\平台建设）时改走英文 junction 入口；目录联接在仓库外，
# 见 ops 文档：mklink /J E:\guyong-platform E:\平台建设\guyong-platform
if any(ord(ch) > 127 for ch in _cache_dir):
    # junction 指向仓库根（E:\guyong-platform → E:\平台建设\guyong-platform）
    _old_root = os.sep.join(["E:", "平台建设", "guyong-platform"])
    _ascii_root = os.sep.join(["E:", "guyong-platform"])
    _ascii_dir = _cache_dir.replace(_old_root, _ascii_root, 1)
    if not any(ord(ch) > 127 for ch in _ascii_dir) and os.path.isdir(_ascii_dir):
        _cache_dir = _ascii_dir
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", _cache_dir)

_lock = threading.Lock()
_engine = None


def _get_engine():
    global _engine
    if _engine is None:
        with _lock:
            if _engine is None:
                from paddleocr import PaddleOCR
                _engine = PaddleOCR(
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_textline_orientation=False,
                    lang="ch",
                    enable_mkldnn=False,
                )
    return _engine


def paddle_ocr_lines(png_path: str) -> list[dict]:
    engine = _get_engine()
    res = engine.predict(os.path.abspath(png_path))
    out: list[dict] = []
    for item in res:
        try:
            texts = item["rec_texts"]
            scores = item["rec_scores"]
            polys = item["rec_polys"]
        except Exception:  # noqa: BLE001
            data = getattr(item, "json", {}) or {}
            data = data.get("res", data)
            texts = data.get("rec_texts", [])
            scores = data.get("rec_scores", [])
            polys = data.get("rec_polys", data.get("dt_polys", []))
        for text, score, poly in zip(texts, scores, polys):
            try:
                xs = [float(p[0]) for p in poly]
                ys = [float(p[1]) for p in poly]
            except Exception:  # noqa: BLE001
                continue
            x0, y0 = int(min(xs)), int(min(ys))
            out.append({"x": x0, "y": y0,
                        "width": int(max(xs) - x0), "height": int(max(ys) - y0),
                        "text": str(text), "confidence": float(score)})
    out.sort(key=lambda l: (l["y"], l["x"]))
    return out
