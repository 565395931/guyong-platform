#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Desktop Bridge 本地节点：把飞鸽界面变化推给 rag-server。

职责
----
1. 连到 rag-server 的 /bridge/v1，用 nodeKey + enrollmentToken 发 node.hello
2. 收 node.ready，从中取到本节点被分配的账号与租约令牌
3. 定期发 node.heartbeat 续租（不续租 45 秒后租约过期）
4. 轮询飞鸽元素树，消息指纹有变化就发 message.inbound
5. 按 ack 结果处理重发：retryable_error 才重试，duplicate/processed 都算成功

设计取舍
--------
- **同步单线程**：轮询循环 + websocket-client 的同步 recv，逻辑直白、易排查。
  桥接是低吞吐场景（客服会话），不值得引入 asyncio。
- **指纹去重**：内容没变就不发（本地先挡一层），服务端再用 channelMessageId 挡一层。
- **对端断线即重连**：指数退避，但不超过 30 秒。

用法
----
  # 先在网页上点【自动检测】建号，然后：
  python bridge_node.py --provision            # 自动签发节点凭据并保存到本地
  python bridge_node.py                        # 用已保存的凭据运行
  python bridge_node.py --status               # 只看当前节点/绑定状态

环境变量
--------
  BRIDGE_SERVER          默认 http://127.0.0.1:3001
  BRIDGE_NODE_TOKEN      节点令牌（不设则读 .bridge-node.json）
  FEIGE_ACCOUNT_ID       绑定的渠道账号 id
  FEIGE_POLL_SECONDS     轮询间隔，默认 3
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

CRED_FILE = os.path.join(HERE, ".bridge-node.json")
OUTBOX_FILE = os.path.join(HERE, ".bridge-outbox.json")
PROTOCOL_VERSION = "1.0"
NODE_VERSION = "1.0.0"

# 一个节点可承载多个适配器（一台机器只能签发一个节点，见 provision 的机指纹幂等）。
# doudian.feige = 飞鸽聊天采集/发送；xiaohongshu.qianfan = 千帆订单定时采集；
# pinduoduo.workbench = 拼多多工作台客服聊天视觉采集（截图+OCR）。
ADAPTER_IDS = ["doudian.feige", "xiaohongshu.qianfan", "pinduoduo.workbench"]

# 拼多多视觉读取器所在目录（独立线程运行，产物走同一条 WS）
PDD_READER_DIR = os.path.normpath(os.path.join(HERE, "..", "pinduoduo-uia-probe"))


def pdd_reader_config() -> dict:
    """环境变量：PDD_READER_ENABLED=1 启用；PDD_READER_INTERVAL_SECONDS 轮询间隔。"""
    enabled = os.environ.get("PDD_READER_ENABLED", "").strip().lower() in ("1", "true", "yes")
    try:
        interval = float(os.environ.get("PDD_READER_INTERVAL_SECONDS", "15"))
    except ValueError:
        interval = 15.0
    return {"enabled": enabled, "interval": max(5.0, interval)}

# 千帆订单定时采集（子进程调用 qianfan-uia-probe/qianfan_orders.py，与节点进程隔离）。
QIANFAN_ORDERS_SCRIPT = os.path.normpath(
    os.path.join(HERE, "..", "qianfan-uia-probe", "qianfan_orders.py"))


def qianfan_orders_config() -> dict:
    """环境变量配置：QIANFAN_ORDERS_ENABLED=1 且 QIANFAN_ORDERS_AT=HH:MM 时启用。"""
    enabled = os.environ.get("QIANFAN_ORDERS_ENABLED", "").strip().lower() in ("1", "true", "yes")
    at = os.environ.get("QIANFAN_ORDERS_AT", "").strip()
    try:
        timeout = float(os.environ.get("QIANFAN_ORDERS_TIMEOUT_SECONDS", "240"))
    except ValueError:
        timeout = 240.0
    return {"enabled": enabled, "at": at, "timeout": timeout}

EXIT_OK = 0
EXIT_NO_DEPENDENCY = 5
EXIT_NO_CREDENTIAL = 6


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


def log(*parts: Any) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}]", *parts, flush=True)


# --------------------------------------------------------------------------
# 协议信封（字段必须与 bridgeProtocol.js 的 zod 校验一致）
# --------------------------------------------------------------------------

def envelope(type_: str, payload: dict, node_key: Optional[str] = None) -> dict:
    env = {
        "protocolVersion": PROTOCOL_VERSION,
        "type": type_,
        "eventId": str(uuid.uuid4()),
        "occurredAt": now_iso(),
        "sentAt": now_iso(),
        "payload": payload,
    }
    if node_key:
        env["nodeId"] = node_key
    return env


# --------------------------------------------------------------------------
# 凭据
# --------------------------------------------------------------------------

def load_credentials() -> Optional[dict]:
    if os.path.exists(CRED_FILE):
        with open(CRED_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    return None


def save_credentials(data: dict) -> None:
    with open(CRED_FILE, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    try:
        os.chmod(CRED_FILE, 0o600)
    except Exception:
        pass


def machine_fingerprint() -> str:
    """与 detect.py 保持完全一致，否则网关的 authenticateNode 匹配不上。"""
    import detect

    return detect.machine_fingerprint()


# --------------------------------------------------------------------------
# 节点主体
# --------------------------------------------------------------------------

class BridgeNode:
    def __init__(self, server: str, credentials: dict, account_id: Optional[int],
                 poll_seconds: float, allow_send: bool = True):
        self.server = server.rstrip("/")
        self.node_key = credentials["nodeKey"]
        self.enrollment_token = credentials["enrollmentToken"]
        self.account_id = account_id
        self.poll_seconds = poll_seconds
        self.allow_send = allow_send

        self.ws = None
        self.accounts: dict[int, dict] = {}
        self.ui_lock = threading.RLock()
        self.pending_events: dict[str, dict] = {}
        self.last_outbox_retry = 0.0
        if self.allow_send and os.path.isfile(OUTBOX_FILE):
            with open(OUTBOX_FILE, encoding="utf-8") as fh:
                self.pending_events = json.load(fh)
        self.leases: list[dict] = []
        self.known_fingerprints: dict[int, set] = {}
        self.last_heartbeat = 0.0
        self.heartbeat_interval = 15.0
        # 当前会话列表里的客户键，供"消失即归档 / 重现即恢复"判定
        self.active_conversation_keys: list = []
        # 当前打开的会话（来自顶栏，可靠）；为空表示读不到当前会话，此时不要归档
        self.current_customer_key = ""
        self.conversation_list_readable = False
        self.last_snapshot = 0.0
        self.snapshot_interval = 10.0
        # 千帆订单定时采集：记录上次执行日期（同日不重复触发；进程重启会重跑一次）
        self.last_qianfan_orders_date: Optional[str] = None
        # 已上报、等待入库确认的订单批次：eventId -> 条数
        self.pending_order_uploads: dict[str, int] = {}
        # 拼多多视觉读取（独立线程）：账号 id 从 node.ready 的租约里按 adapterId 认领
        self.pdd_account_id: Optional[int] = None
        self.pdd_queue: "queue.Queue[dict]" = queue.Queue()
        self.pdd_thread: Optional[threading.Thread] = None
        self.pdd_stop = threading.Event()
        # 待执行的发送指令（服务端 -> 节点 -> 桌面客户端）
        self.command_queue: list[dict] = []
        # 头像内容签名：同一客户头像没变就不重复上传
        self.avatar_signatures: dict[str, str] = {}
        # 窗口不可见只提醒一次，避免每轮刷日志
        self.warned_not_capturable = False

    # -- 连接 ------------------------------------------------------------
    def ws_url(self) -> str:
        base = self.server
        if base.startswith("https://"):
            base = "wss://" + base[len("https://"):]
        elif base.startswith("http://"):
            base = "ws://" + base[len("http://"):]
        return base + "/bridge/v1"

    def connect(self) -> None:
        import websocket

        log("连接", self.ws_url())
        self.ws = websocket.create_connection(self.ws_url(), timeout=10)
        hello = envelope("node.hello", {
            "enrollmentToken": self.enrollment_token,
            "machineFingerprint": machine_fingerprint(),
            "version": NODE_VERSION,
            "displayName": os.environ.get("BRIDGE_NODE_NAME") or "local-feige-node",
            "adapterIds": ADAPTER_IDS,
            "capabilities": {"uia": True, "platform": "windows"},
        }, node_key=self.node_key)
        self.ws.send(json.dumps(hello))
        log("已发送 node.hello，等待 node.ready…")

    def _recv(self, timeout: float = 3.0) -> Optional[dict]:
        import websocket

        self.ws.settimeout(timeout)
        try:
            raw = self.ws.recv()
        except websocket.WebSocketTimeoutException:
            return None
        if not raw:
            raise ConnectionError("连接已关闭")
        return json.loads(raw)

    def handle_frame(self, frame: dict) -> None:
        type_ = frame.get("type")
        if type_ == "node.ready":
            config = frame.get("payload", {}).get("configuration", {}) or {}
            self.heartbeat_interval = float(config.get("heartbeatIntervalMs", 15000)) / 1000.0
            accounts = config.get("accounts", []) or []
            self.accounts = {int(a["accountId"]): a for a in accounts}
            self.leases = [
                {
                    "accountId": a["accountId"],
                    "leaseToken": a["leaseToken"],
                    "generation": a["generation"],
                }
                for a in accounts
            ]
            feige_accounts = [a for a in accounts if a.get("adapterId") == "doudian.feige"]
            if self.account_id not in [int(a["accountId"]) for a in feige_accounts]:
                self.account_id = int(feige_accounts[0]["accountId"]) if len(feige_accounts) == 1 else None
            self.pdd_account_id = None
            pdd_accounts = [a for a in accounts if a.get("adapterId") == "pinduoduo.workbench"]
            for account in accounts:
                if len(pdd_accounts) == 1 and account.get("adapterId") == "pinduoduo.workbench":
                    self.pdd_account_id = int(account["accountId"])
            log(f"node.ready：下发 {len(accounts)} 个账号，租约 {len(self.leases)} 个"
                f"，心跳间隔 {self.heartbeat_interval:.0f}s")
            for account in accounts:
                log(f"  · 账号 {account['accountId']} {account.get('channel')} "
                    f"{account.get('accountName')} adapter={account.get('adapterId')}")
            if self.pdd_account_id is not None:
                log(f"[拼多多] 已认领账号 id={self.pdd_account_id}")
            self.start_pdd_reader()
            return

        if type_ == "event.ack":
            payload = frame.get("payload", {})
            status = payload.get("status")
            ack_for = payload.get("ackForEventId")
            if status in ("processed", "duplicate", "rejected") and ack_for in self.pending_events:
                self.pending_events.pop(ack_for)
                self._save_outbox()
            pending = getattr(self, "pending_order_uploads", None)
            if pending is not None and ack_for in pending:
                count = pending.pop(ack_for)
                detail = payload.get("message") or ""
                if status == "processed":
                    log(f"[千帆订单] 入库确认：{detail}（上报 {count} 条）")
                else:
                    log(f"[千帆订单] 入库失败：{status} {payload.get('errorCode') or ''} "
                        f"{detail}（上报 {count} 条）")
            elif status in ("processed", "duplicate"):
                pass
            else:
                log(f"ack 异常: {status} {payload.get('errorCode') or ''} "
                    f"{payload.get('message') or ''}")
            return

        if type_ == "message.send":
            self.command_queue.append(frame)
            payload = frame.get("payload", {})
            # commandId 在**信封层**，与 payload 平级（bridgeProtocol.js:129），
            # 不在 payload 里面——读错位置会拿到 None，导致从不回报状态、后端只能超时。
            log(f"收到发送指令 {str(frame.get('commandId'))[:8]} "
                f"len={len(str(payload.get('content') or ''))} 已入队")
            return

        if type_ == "server.error":
            payload = frame.get("payload", {})
            log(f"服务端错误: {payload.get('code')} {payload.get('message')}")
            if not payload.get("retryable"):
                raise ConnectionError(f"服务端拒绝: {payload.get('code')}")
            return

        log("未处理报文类型:", type_)

    def send_heartbeat(self) -> None:
        self.ws.send(json.dumps(envelope("node.heartbeat", {
            "leases": self.leases,
            "health": {"version": NODE_VERSION, "pending": 0},
        }, node_key=self.node_key)))
        self.last_heartbeat = time.monotonic()

    def _save_outbox(self) -> None:
        with open(OUTBOX_FILE + ".tmp", "w", encoding="utf-8") as fh:
            json.dump(self.pending_events, fh, ensure_ascii=False)
        os.replace(OUTBOX_FILE + ".tmp", OUTBOX_FILE)

    def send_reliable(self, event: dict) -> None:
        if not self.allow_send:
            return
        self.pending_events[event["eventId"]] = event
        self._save_outbox()  # 先落盘，再发送；ACK 丢失时使用相同 eventId 重放。
        self.ws.send(json.dumps(event, ensure_ascii=False))

    def retry_outbox(self) -> None:
        if not self.allow_send or time.monotonic() - self.last_outbox_retry < 10:
            return
        self.last_outbox_retry = time.monotonic()
        for event in list(self.pending_events.values()):
            if event.get("nodeId") == self.node_key:
                self.ws.send(json.dumps(event, ensure_ascii=False))

    def send_command_status(self, command_id: str, status: str,
                            platform_message_id: Optional[str] = None,
                            error_code: Optional[str] = None,
                            error_message: Optional[str] = None) -> None:
        payload = {"commandId": command_id, "status": status}
        if platform_message_id:
            payload["platformMessageId"] = str(platform_message_id)[:255]
        if error_code:
            payload["errorCode"] = str(error_code)[:80]
        if error_message:
            payload["errorMessage"] = str(error_message)[:500]
        self.ws.send(json.dumps(envelope("message.command.status", payload,
                                         node_key=self.node_key)))

    def run_command(self, frame: dict) -> None:
        """执行一条发送指令并回报状态。

        实际写入/点击逻辑在 feige_send.send_text，它自带三道验证：
        会话校验（防止把消息发给别的客户）、写入后回读、发送后确认输入框已清空。
        """
        payload = frame.get("payload") or {}
        command_id = frame.get("commandId") or payload.get("commandId")
        if not command_id:
            return
        account = self.accounts.get(payload.get("accountId"), {})
        if not self.allow_send or account.get("adapterId") != "doudian.feige":
            self.send_command_status(command_id, "failed", error_code="ADAPTER_SEND_UNAVAILABLE",
                                     error_message="This account has no enabled desktop sender")
            return
        import feige_send
        text = str(payload.get("content") or "")
        # targetUserId 是客户键，节点用它确认客户端当前打开的会话就是这个客户
        expect = payload.get("targetUserId") or payload.get("platformConversationId")

        try:
            with self.ui_lock:
                result = feige_send.send_text(text, expect_customer_key=expect or None)
        except Exception as exc:  # noqa: BLE001
            log(f"发送指令 {str(command_id)[:8]} 执行异常: {type(exc).__name__}: {exc}")
            self.send_command_status(command_id, "failed",
                                     error_code="NODE_EXCEPTION",
                                     error_message=f"{type(exc).__name__}: {exc}")
            return

        if result.get("ok"):
            log(f"发送成功 {str(command_id)[:8]}（{result.get('detail')}），"
                f"内容长度 {len(text)}")
            self.send_command_status(command_id, "succeeded")
        else:
            log(f"发送失败 {str(command_id)[:8]} code={result.get('code')} "
                f"{result.get('detail')}")
            self.send_command_status(command_id, "failed",
                                     error_code=result.get("code") or "SEND_FAILED",
                                     error_message=result.get("detail") or "")

    def capture_customer_avatar(self, tree: dict, customer_key: str) -> Optional[str]:
        """截当前客户头像并返回 base64 PNG；内容没变则返回 None。

        飞鸽界面的头像节点只有 name='头像'，没有 URL/路径，只能按 rect 截屏。
        优先取"离顶栏最近"的那个头像——顶栏显示的就是当前会话客户；
        会话列表里每个客户也有头像，但那是别人的。
        """
        import base64

        import feige_capture
        from feige_extract import descendants

        topbar_y = None
        for node in descendants(tree):
            if (node.get("aid") or "") == "topbar-left-info":
                rect = node.get("rect") or {}
                if rect.get("width"):
                    topbar_y = rect.get("top")
                break

        best = None
        for node in descendants(tree):
            if node.get("type") != "ImageControl" or (node.get("name") or "") != "头像":
                continue
            rect = node.get("rect") or {}
            if int(rect.get("width") or 0) < 20 or not rect.get("left"):
                continue
            score = abs((rect.get("top") or 0) - (topbar_y or 0)) if topbar_y else 0
            if best is None or score < best[0]:
                best = (score, rect)
        if best is None:
            return None

        png = feige_capture.capture_rect(best[1])
        if not png:
            return None
        signature = feige_capture.image_signature(png)
        if self.avatar_signatures.get(customer_key) == signature:
            return None
        self.avatar_signatures[customer_key] = signature
        log(f"截到客户头像（{len(png)} 字节，签名 {signature}）")
        return base64.b64encode(png).decode("ascii")

    def maybe_collect_qianfan_orders(self) -> None:
        """到点采集千帆订单（子进程执行，与节点主循环隔离）。

        说明：
        - 采集期间聊天轮询会暂停（主循环内联执行）；飞鸽读界面是无状态的，
          恢复后下一轮会把期间的消息按指纹补读，不会丢。
        - 采集脚本内部有 try/finally：无论成败都会把千帆界面点回客服页。
        - 触发即记账（同日不重跑），避免采集失败后每轮循环反复触发。
        """
        cfg = qianfan_orders_config()
        if not cfg["enabled"] or not cfg["at"]:
            return
        now = datetime.now()
        try:
            hh, mm = (int(part) for part in cfg["at"].split(":", 1))
            due = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        except ValueError:
            log(f"QIANFAN_ORDERS_AT 格式应为 HH:MM，收到 {cfg['at']!r}，本日跳过")
            self.last_qianfan_orders_date = now.date().isoformat()
            return
        today = now.date().isoformat()
        if now < due or self.last_qianfan_orders_date == today:
            return
        self.last_qianfan_orders_date = today

        log(f"[千帆订单] 定时采集开始（{cfg['at']}），聊天轮询暂停至采集完成…")
        started = time.monotonic()
        succeeded = False
        try:
            proc = subprocess.run(
                [sys.executable, QIANFAN_ORDERS_SCRIPT, "collect"],
                capture_output=True, text=True, timeout=cfg["timeout"],
                encoding="utf-8", errors="replace", cwd=os.path.dirname(QIANFAN_ORDERS_SCRIPT))
            for line in (proc.stdout or "").strip().splitlines()[:8]:
                log("  " + line)
            if proc.returncode != 0:
                stderr_tail = (proc.stderr or "")[:200]
                log(f"[千帆订单] 退出码={proc.returncode}，stderr: {stderr_tail}")
            else:
                succeeded = True
        except subprocess.TimeoutExpired:
            log(f"[千帆订单] 超时（>{cfg['timeout']:.0f}s），已放弃本轮；"
                "采集脚本会自行把界面切回客服页")
        except Exception as exc:  # noqa: BLE001
            log(f"[千帆订单] 失败：{type(exc).__name__}: {exc}")
        finally:
            log(f"[千帆订单] 本轮结束，用时 {time.monotonic() - started:.0f}s")

        if succeeded:
            self.upload_scraped_orders()

    def upload_scraped_orders(self) -> None:
        """把最近一次采集结果上报服务端入库（commerce.orders.scraped）。

        - 读采集器落盘的 latest JSON（节点不解析 stdout，避免格式耦合）；
        - 入库幂等键是订单号，每日重跑不产生重复行；
        - 入库确认在 event.ack 里回来（见 handle_frame），失败只记日志不重试——
          下一轮定时采集会自然重报，人工也可重跑采集补齐。
        """
        if self.ws is None:
            log("[千帆订单] 未连接服务端，跳过订单上报（本轮结果留在本机 out/）")
            return
        if not self.allow_send:
            log("[千帆订单] --dry-run：跳过订单上报")
            return
        latest = os.path.normpath(os.path.join(
            os.path.dirname(QIANFAN_ORDERS_SCRIPT), "out", "qianfan_orders_latest.json"))
        try:
            with open(latest, encoding="utf-8") as fh:
                payload = json.load(fh)
        except Exception as exc:  # noqa: BLE001
            log(f"[千帆订单] 读取采集结果失败（{latest}）：{type(exc).__name__}: {exc}")
            return
        orders = ((payload.get("orders") or {}).get("rows")) or []
        accounts = [a for a in self.accounts.values() if a.get("adapterId") == "xiaohongshu.qianfan"]
        if len(accounts) != 1:
            log("[千帆订单] 需要唯一的已绑定千帆账号，跳过上报")
            return
        if not orders:
            log("[千帆订单] 本次采集无订单，跳过上报")
            return
        env = envelope("commerce.orders.scraped", {
            "adapterId": payload.get("adapterId") or "xiaohongshu.qianfan",
            "source": "qianfan_orders",
            "accountId": int(accounts[0]["accountId"]),
            "capturedAt": payload.get("capturedAt"),
            "orders": orders,
        }, node_key=self.node_key)
        self.pending_order_uploads[env["eventId"]] = len(orders)
        self.send_reliable(env)
        log(f"[千帆订单] 已上报 {len(orders)} 条订单，等待入库确认…")

    def start_pdd_reader(self) -> None:
        """启动拼多多视觉读取线程（幂等；未启用或已启动则直接返回）。"""
        cfg = pdd_reader_config()
        if not cfg["enabled"] or self.pdd_thread is not None:
            if not cfg["enabled"]:
                log("[拼多多] 未启用（PDD_READER_ENABLED 未设置）")
            return
        if PDD_READER_DIR not in sys.path:
            sys.path.insert(0, PDD_READER_DIR)
        try:
            import pdd_reader  # noqa: PLC0415
        except Exception as exc:  # noqa: BLE001
            log(f"[拼多多] 读取器导入失败: {type(exc).__name__}: {exc}")
            return

        def loop() -> None:
            reader = pdd_reader.PddChatReader(scale=2)
            try:
                sentinel = pdd_reader.PddSentinel()
                log("[拼多多] 哨兵已启用：只盯拼多多进程的浮窗 + 待回复区域像素差分"
                    "（2 秒/次心跳，探测到变化才做完整 OCR 读取）")
            except Exception as exc:  # noqa: BLE001
                sentinel = None
                log(f"[拼多多] 哨兵初始化失败，回退定时轮询: {exc}")
            last_full = 0.0
            while not self.pdd_stop.is_set():
                if self.pdd_account_id is None or self.ws is None:
                    self.pdd_stop.wait(2.0)
                    continue
                triggered = False
                try:
                    if sentinel is not None:
                        main_probe = pdd_reader.find_main_window()
                        if main_probe:
                            triggered = sentinel.tick(main_probe)
                except Exception:  # noqa: BLE001
                    triggered = True  # 哨兵异常时保守触发一次完整读取
                due = (time.monotonic() - last_full) >= max(10.0, cfg["interval"])
                if not (triggered or due):
                    self.pdd_stop.wait(2.0)
                    continue
                last_full = time.monotonic()
                try:
                    with self.ui_lock:
                        result = reader.read_once(only_changed=not due, log=lambda m: log(f"[拼多多] {m}"))
                    for index, msg in enumerate(result.get("newMessages", [])):
                        if self.pdd_account_id is None:
                            log("[拼多多] 尚未认领账号（等待 node.ready），本条留在下轮")
                            break
                        self.pdd_queue.put(self._pdd_payload(msg, index))
                except Exception as exc:  # noqa: BLE001
                    import traceback
                    log(f"[拼多多] 读取异常: {type(exc).__name__}: {exc}")
                    log(traceback.format_exc())
                self.pdd_stop.wait(1.0)

        self.pdd_thread = threading.Thread(target=loop, name="pdd-reader", daemon=True)
        self.pdd_thread.start()
        log(f"[拼多多] 读取线程已启动（间隔 {cfg['interval']:.0f}s）")

    def _pdd_payload(self, msg: dict, batch_index: int) -> dict:
        """读取器消息 → message.inbound 负载（与 inboundBridgeService 的约定一致）。

        ⚠️ clientTimestamp 为空时必须**省略该字段**而不是给 null：
        协议里它是 `timestamp.optional()`（允许缺省、不允许 null），
        传 null 会导致 INVALID_ENVELOPE、网关直接断开连接（实测踩过）。
        """
        direction = "in" if msg.get("direction") == "in" else "out"
        payload = {
            "accountId": self.pdd_account_id,
            "channel": "pinduoduo",
            "platformConversationId": msg["conversationKey"],
            "platformCustomerId": msg["conversationKey"],
            "channelMessageId": msg["fingerprint"],
            "userName": msg["conversationName"],
            "content": msg["text"],
            "messageType": "text",
            "media": [],
            "platformPayload": {
                "direction": direction,
                "directionBasis": "pdd_visual_left_right",
                "batchIndex": batch_index,
                "source": "pinduoduo.workbench",
                "timePrecision": "minute",
                "observedDirection": direction,
            },
        }
        if msg.get("clientTimestamp"):
            payload["clientTimestamp"] = msg["clientTimestamp"]
        return payload

    def send_account_snapshot(self) -> None:
        """上报当前会话列表，供后端判定归档/恢复。

        带上 inCurrentList 的客户键即可：后端据此把"不在列表里"的会话归档、
        把"重新出现"的从归档拉回 AI 池。协议里本就有 account.snapshot 这个类型，
        但网关此前只是放行、不做处理。
        """
        if not self.account_id:
            return
        self.ws.send(json.dumps(envelope("account.snapshot", {
            "accounts": [{
                "accountId": self.account_id,
                "channel": "douyin",
                "activeConversationKeys": self.active_conversation_keys,
                # 列表是否真的读到了：后端据此区分"列表为空"与"容器读不到"，
                # 前者要归档（含顶栏还停着的会话），后者必须跳过
                "conversationListReadable": self.conversation_list_readable,
                "currentCustomerKey": self.current_customer_key,
            }]
        }, node_key=self.node_key)))
        self.last_snapshot = time.monotonic()

    # -- 采集 ------------------------------------------------------------
    def poll_once(self) -> list[dict]:
        """读一次界面，返回需要上报的 message.inbound 负载。"""
        from feige_extract import (
            active_conversation_keys, assign_occurrences, build_tree,
            conversation_list_readable, current_customer, digest12, extract_messages,
            resolve_render_host,
        )
        from feige_extract import fingerprint as make_fingerprint

        host = resolve_render_host()
        tree = build_tree(host["control"])
        shop_name = host["shop_title"].replace("[商家]", "").strip()

        # 真实客户信息（未脱敏）：业务库必须存真实昵称，否则界面认不出客户。
        # 脱敏只用于报告，不用于入库。
        customer = current_customer(tree, shop_name) or {}
        customer_key = customer.get("customerKey") or digest12(f"{shop_name}|unknown")
        conv_key = customer.get("conversationKey") or digest12(f"{shop_name}|unknown|current")
        customer_name = customer.get("rawName") or ""
        # 会话列表里所有会话的客户键，供"消失即归档/重现即恢复"判定
        self.active_conversation_keys = active_conversation_keys(tree, shop_name)
        # 与"列表为空"区分开：容器不存在=读不到，不能据此归档
        self.conversation_list_readable = conversation_list_readable(tree)
        # 当前打开的会话客户键：归档判定以它为准（比扫列表可靠——
        # 列表项识别可能把聊天区的消息行也算进去）
        self.current_customer_key = customer_key if customer else ""

        messages = extract_messages(tree, shop_name=shop_name)
        assign_occurrences(messages)
        for msg in messages:
            msg["fingerprint"] = make_fingerprint(msg, conv_key)

        # 截图前必须确认窗口真的在屏幕上。
        # 窗口最小化时 UIA 返回的是**相对窗口**坐标，而截屏 API 要的是**绝对屏幕**坐标，
        # 直接拿去截会截到屏幕上那个位置的无关内容（实测截到了灰色渐变）。
        capturable = False
        try:
            import feige_capture

            capturable = feige_capture.is_capturable(host["render_host_hwnd"])
        except Exception as exc:  # noqa: BLE001
            log(f"窗口可截性检查失败: {type(exc).__name__}: {exc}")
        if not capturable and not self.warned_not_capturable:
            log("⚠️ 飞鸽窗口最小化或不可见：已跳过头像与表情截图"
                "（此状态下 UIA 坐标是相对值，不能用于截屏）")
            self.warned_not_capturable = True
        elif capturable:
            self.warned_not_capturable = False

        account_id = self.account_id
        seen = self.known_fingerprints.setdefault(account_id or 0, set())
        fresh: list[dict] = []
        for msg in messages:
            if msg["fingerprint"] in seen:
                continue
            # 客户消息与商家消息都上报：
            #   direction=in  -> 后端走 processIncomingMessage（入站通道）
            #   direction=out/system -> 后端走独立入库路径按 outbound 落库
            # 之前这里跳过 out/system，导致"我在客户端里回客户"的对话在程序里看不到。
            payload = self.build_inbound(
                msg, account_id, conv_key, customer_key, shop_name, customer_name,
                capturable=capturable)
            # 批次内序号：后端用它给 created_at 加毫秒偏移，
            # 保证同一秒内的多条消息也**严格按页面顺序**入库
            payload.setdefault("platformPayload", {})["batchIndex"] = len(fresh)
            fresh.append(payload)
        # 记住全部指纹（含跳过的），避免下一轮重复判定
        seen.update(msg["fingerprint"] for msg in messages)
        # 头像截取已**按要求关闭**：改用昵称首字兜底。
        # 前端 getConversationAvatarText() 本来就是取显示名第一个字
        # （conversationDisplay.js:27），只要不设 user_avatar 就会显示首字。
        # 截图方案的实际问题：飞鸽头像节点没有 URL、只能按 rect 屏幕截取；
        # 而窗口最小化时 UIA 返回相对坐标、截出来是无关内容，可靠性不够，所以弃用。
        # 后端 saveAvatar 保留但不会被触发（没有 avatarPng 就不执行），日后想启用只需恢复下面几行。
        #
        # avatar_b64 = None
        # if fresh and customer_key and capturable:
        #     avatar_b64 = self.capture_customer_avatar(tree, customer_key)
        # if avatar_b64:
        #     fresh[0].setdefault("platformPayload", {})["avatarPng"] = avatar_b64

        return fresh

    @staticmethod
    def build_inbound(msg: dict, account_id: Optional[int], conv_key: str,
                      customer_key: str, shop_name: str, customer_name: str = "",
                      capturable: bool = True) -> dict:
        from bridge_adapter import compose_timestamp

        # 是否媒体消息：占位文字是**方括号标签**，如 [发呆] / [图片] / [视频]。
        # 踩过两次坑：
        #   1. 按 content_length<=4 判断 → "不会"、"转人工" 这类短消息被误判成图片；
        #   2. 按 ('表情','图片',…) 精确匹配 → 漏掉 [发呆] 这种，仍被当文本。
        # 表情在元素树里的图片节点 name 也是同样的方括号标签（name='[发呆]'）。
        raw_content = (msg.get("content_raw") or "").strip()
        is_media = (
            2 < len(raw_content) <= 14
            and raw_content.startswith("[")
            and raw_content.endswith("]")
        )
        # clientTimestamp 必须是带时区的 ISO 时间；界面给的 '17:43:23' 直接送会被
        # zod 拒掉（schema 要求 z.string().datetime({offset:true})），而网关对校验失败
        # 是**静默关闭连接**、不记日志，很难排查。这里统一用 compose_timestamp 补全。
        iso, precision = compose_timestamp(
            msg["time_text"], datetime.now(timezone.utc).astimezone())

        payload: dict = {
            "accountId": account_id,
            "channel": "douyin",
            "platformConversationId": conv_key,
            "platformCustomerId": customer_key,
            "channelMessageId": msg["fingerprint"][:64],
            # userName 存进 conversations.user_name，是界面用来认客户的名字，
            # 所以必须是**真实昵称**、不能脱敏（脱敏只用于报告）。
            "userName": customer_name or shop_name,
            "messageType": "text",
            "platformPayload": {
                "direction": msg["direction"],
                "directionBasis": msg["direction_basis"],
                "readState": msg["read_state"] or None,
                "timeText": msg["time_text"],
                "timePrecision": precision,
                "contentDigest": msg["content_digest"],
                "contentLength": msg["content_length"],
                "senderLabel": msg["sender_label"],
            },
        }
        # 商品卡：**不截图**，只把"名字 + 售价"作为文字入库（用户要求）。
        # 卡片里的保障/优惠/物流/按钮都是噪音，已在 feige_extract 里剔掉。
        # 与表情的区别：表情用标签（如 [抱紧自己]）；商品卡保留名字与售价两行。
        is_card = bool(msg.get("is_card"))
        if is_card:
            payload["content"] = raw_content or "[商品卡]"
            payload["platformPayload"]["cardName"] = msg.get("card_name") or ""
            payload["platformPayload"]["cardPrice"] = msg.get("card_price") or ""
        else:
            payload["content"] = raw_content or f"[{msg['content_length']} 字]"
        if iso:
            payload["clientTimestamp"] = iso
        return payload

    # -- 主循环 ----------------------------------------------------------
    def _heartbeat_loop(self, stop: threading.Event) -> None:
        # OCR/历史回翻/订单采集可能超过租约 TTL；续租不能等 UI 操作结束。
        while not stop.wait(1.0):
            if self.ws and self.leases and time.monotonic() - self.last_heartbeat >= self.heartbeat_interval:
                try:
                    self.send_heartbeat()
                except Exception:
                    pass  # 主循环负责重连。

    def run(self, max_iterations: Optional[int] = None) -> int:
        heartbeat_stop = threading.Event()
        thread = threading.Thread(target=self._heartbeat_loop, args=(heartbeat_stop,), daemon=True)
        thread.start()
        try:
            return self._run_main(max_iterations)
        finally:
            heartbeat_stop.set()
            self.pdd_stop.set()

    def _run_main(self, max_iterations: Optional[int] = None) -> int:
        if self.account_id is None:
            log("尚未确定账号 id，等待 node.ready 下发…")
        if not self.allow_send:
            log("⚠️ --dry-run：只打印将要上报的消息，不真的发送")

        iterations = 0
        while max_iterations is None or iterations < max_iterations:
            iterations += 1
            try:
                if self.ws is None:
                    self.connect()

                # 1) 处理所有已到达的报文（含 node.ready / ack）
                deadline = time.monotonic() + 1.0
                while time.monotonic() < deadline:
                    frame = self._recv(timeout=0.3)
                    if frame is None:
                        break
                    self.handle_frame(frame)

                # 2) 续租
                self.retry_outbox()
                if self.leases and time.monotonic() - self.last_heartbeat >= self.heartbeat_interval:
                    self.send_heartbeat()

                # 2.5) 上报当前会话列表（归档/恢复判定用）
                if (self.account_id and self.leases
                        and time.monotonic() - self.last_snapshot >= self.snapshot_interval):
                    self.send_account_snapshot()

                # 2.7) 执行发送指令（服务端下发 -> 写入飞鸽 -> 点击发送）
                while self.command_queue:
                    self.run_command(self.command_queue.pop(0))

                # 2.8) 千帆订单定时采集（到点触发；采集期间本循环暂停，恢复后补读消息）
                with self.ui_lock:
                    self.maybe_collect_qianfan_orders()

                # 2.85) 上报拼多多读取器产出的消息（线程摄入队列，这里统一发 WS）
                while self.allow_send and not self.pdd_queue.empty():
                    payload = self.pdd_queue.get()
                    try:
                        self.send_reliable(envelope("message.inbound", payload, node_key=self.node_key))
                        log(f"[拼多多] 已上报 {payload['channelMessageId'][:12]} "
                            f"dir={payload['platformPayload']['direction']} "
                            f"conv={payload['platformConversationId']} "
                            f"len={len(payload['content'])}")
                    except Exception as exc:  # noqa: BLE001
                        self.pdd_queue.put(payload)
                        log(f"[拼多多] 上报失败: {type(exc).__name__}: {exc}")
                        raise

                # 3) 采集并上报
                try:
                    fresh = self.poll_once() if self.account_id else []
                except SystemExit as exc:
                    log("读取界面失败（客户端可能未运行或已最小化）:", str(exc)[:120])
                    fresh = []

                for payload in fresh:
                    if not payload.get("accountId"):
                        log("跳过：账号 id 未知")
                        continue
                    if not self.allow_send:
                        log(f"[DRY-RUN] 将上报 channelMessageId={payload['channelMessageId'][:12]} "
                            f"dir={payload['platformPayload']['direction']} "
                            f"len={payload['platformPayload']['contentLength']}")
                        continue
                    self.send_reliable(envelope("message.inbound", payload, node_key=self.node_key))
                    log(f"已上报 {payload['channelMessageId'][:12]} "
                        f"dir={payload['platformPayload']['direction']} "
                        f"len={payload['platformPayload']['contentLength']}")

                time.sleep(self.poll_seconds)
            except KeyboardInterrupt:
                log("收到中断，退出")
                return EXIT_OK
            except Exception as exc:  # noqa: BLE001
                close_code = getattr(self.ws, "close_status_code", None) if self.ws else None
                close_reason = getattr(self.ws, "close_reason", None) if self.ws else None
                # 网关对协议校验失败是静默 closePolicy（不写日志），所以这里必须把
                # 关闭码/原因打出来，否则只剩一句"连接已关闭"完全无法定位。
                if close_code or close_reason:
                    log(f"对端关闭连接 code={close_code} reason={close_reason!r}")
                log(f"循环异常：{type(exc).__name__}: {exc}；3 秒后重连")
                self.ws = None
                self.leases = []
                time.sleep(3)
        return EXIT_OK


# --------------------------------------------------------------------------
# provision / status
# --------------------------------------------------------------------------

def http_json(method: str, url: str, token: Optional[str] = None,
              body: Optional[dict] = None) -> dict:
    import urllib.error
    import urllib.request

    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"{method} {url} -> HTTP {error.code}: {detail[:300]}")


def do_provision(server: str, token: Optional[str], shop_name: str) -> int:
    if not token:
        raise SystemExit("provision 需要登录令牌：设置 BRIDGE_ADMIN_TOKEN 环境变量"
                         "（网页登录后从浏览器 Local Storage 取 token）")
    result = http_json("POST", f"{server}/api/v1/desktop-bridge/provision", token=token, body={
        "machineFingerprint": machine_fingerprint(),
        "displayName": f"feige@{os.environ.get('COMPUTERNAME') or 'local'}",
        "version": NODE_VERSION,
        "adapterIds": ADAPTER_IDS,
        "capabilities": {"uia": True},
    })
    data = result.get("data", {})
    if not data.get("nodeKey"):
        raise SystemExit(f"签发失败：{json.dumps(result, ensure_ascii=False)[:300]}")
    save_credentials(data)
    log("凭据已保存到", CRED_FILE)
    log("  nodeId  =", data.get("nodeId"))
    log("  nodeKey =", data.get("nodeKey"))
    if data.get("rotated"):
        log("  ⚠️ 该机器已有节点，令牌已轮换，旧 token 立即失效")
    return EXIT_OK


def do_status(server: str, token: Optional[str]) -> int:
    if not token:
        raise SystemExit("status 需要登录令牌：设置 BRIDGE_ADMIN_TOKEN 环境变量")
    result = http_json("GET", f"{server}/api/v1/desktop-bridge/nodes", token=token)
    data = result.get("data", {})
    log("节点:")
    for node in data.get("nodes", []):
        log(f"  [{node['id']}] {node['displayName']} status={node['status']} "
            f"lastSeen={node['lastSeenAt']}")
    log("绑定:")
    for binding in data.get("bindings", []):
        log(f"  账号 {binding['channelAccountId']} {binding['channel']} "
            f"{binding['accountName']} adapter={binding['adapterId']} "
            f"enabled={binding['enabled']} preferredNode={binding['preferredNodeId']}")
    log("租约:")
    for lease in data.get("leases", []):
        log(f"  账号 {lease['channelAccountId']} node={lease['nodeId']} "
            f"gen={lease['generation']} expires={lease['expiresAt']}")
    return EXIT_OK


def main() -> int:
    parser = argparse.ArgumentParser(description="Desktop Bridge 本地节点")
    parser.add_argument("--server", default=os.environ.get("BRIDGE_SERVER", "http://127.0.0.1:3001"))
    parser.add_argument("--provision", action="store_true", help="签发节点凭据并保存")
    parser.add_argument("--status", action="store_true", help="查看节点与绑定状态")
    parser.add_argument("--account-id", type=int, default=None)
    parser.add_argument("--poll-seconds", type=float, default=3.0)
    parser.add_argument("--dry-run", action="store_true", help="只打印不上报")
    parser.add_argument("--iterations", type=int, default=None, help="跑多少轮后退出（调试用）")
    args = parser.parse_args()

    try:
        import websocket  # noqa: F401
    except ImportError:
        print("缺少依赖 websocket-client，安装：python -m pip install websocket-client",
              file=sys.stderr)
        return EXIT_NO_DEPENDENCY

    token = os.environ.get("BRIDGE_ADMIN_TOKEN")

    if args.provision:
        return do_provision(args.server, token, "")
    if args.status:
        return do_status(args.server, token)

    credentials = load_credentials()
    env_token = os.environ.get("BRIDGE_NODE_TOKEN")
    if env_token:
        credentials = {"nodeKey": os.environ.get("BRIDGE_NODE_KEY"), "enrollmentToken": env_token}
    if not credentials or not credentials.get("nodeKey"):
        print("未找到节点凭据。先运行：python bridge_node.py --provision", file=sys.stderr)
        return EXIT_NO_CREDENTIAL

    account_id = args.account_id
    if account_id is None and os.environ.get("FEIGE_ACCOUNT_ID"):
        account_id = int(os.environ["FEIGE_ACCOUNT_ID"])

    node = BridgeNode(
        server=args.server,
        credentials=credentials,
        account_id=account_id,
        poll_seconds=args.poll_seconds,
        allow_send=not args.dry_run,
    )
    return node.run(max_iterations=args.iterations)


if __name__ == "__main__":
    raise SystemExit(main())
