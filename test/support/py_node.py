"""互通测试的 Python 侧节点。用法：

    python test/support/py_node.py <nodes_dir> eager    # FULL_PEER：主动发现并拨号
    python test/support/py_node.py <nodes_dir> lazy     # 只宣告+接受入站（被 TS 拨）

事件以 JSON 行打到 stdout（flush），TS 侧的测试据此断言。

注意：**不在 on_connected 回调里发报文**。参考实现的 `_finish_handshake` 在
`handshake_inbound` 发送 ACK **之前**就触发回调，回调里 call() 会让线上顺序变成
`HELLO → tool_call →（阻塞）→ ACK`，对端在等 ACK 时收到 tool_call 会判握手失败，
双方死锁到超时。这里改用后台线程等「连接出现在 connections() 里」再动作。
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

_MSP_SRC = Path(__file__).resolve().parents[2].parent / "ModelSensingProtocol" / "src"
sys.path.insert(0, str(_MSP_SRC))

from msp.core.node import MSPNode                    # noqa: E402
from msp.core.preset import Preset                   # noqa: E402


def emit(event: dict) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


def act_when_connected(node, peer_id: str, action, timeout: float = 30.0) -> None:
    """等对端真的进连接表（握手 + ACK 完成）之后再动作。"""

    def worker() -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if peer_id in node.connections():
                try:
                    action()
                except Exception as exc:      # 不让后台线程静默死掉
                    emit({"event": "actor_error", "peer": peer_id,
                          "error": f"{type(exc).__name__}: {exc}"})
                return
            time.sleep(0.1)
        emit({"event": "actor_timeout", "peer": peer_id})

    threading.Thread(target=worker, daemon=True).start()


def main() -> int:
    nodes_dir, mode = sys.argv[1], sys.argv[2]

    if mode == "eager":
        node = MSPNode(
            "py_a", preset=Preset.FULL_PEER, nodes_dir=nodes_dir,
            config={"discovery": {"directory": {"poll_interval": 0.5}}},
        )

        @node.tool("py_echo", "回声")
        def py_echo(msg: str) -> dict:
            return {"echo": msg}

        @node.on("sensor.ts.**")
        def on_ts_signal(sig):
            emit({"event": "py_received", "path": sig.path, "payload": sig.payload})

        node.start()
        emit({"event": "py_started", "mode": mode})

        def do_calls() -> None:
            r = node.call("ts_b", "ts_add", {"a": 2, "b": 3}, timeout=10.0)
            emit({
                "event": "py_called_ts_add",
                "ok": not r.is_error,
                "value": r.unwrap() if not r.is_error else r.error,
            })
            node.publish("notify.from_py.hello", {"greeting": "hi from python"})

        act_when_connected(node, "ts_b", do_calls)
    else:
        node = MSPNode("zz_lazy", preset=Preset.LOCAL_TOOL, nodes_dir=nodes_dir)

        @node.tool("lazy_double", "翻倍")
        def lazy_double(x: int) -> dict:
            return {"doubled": x * 2}

        node.start()
        emit({"event": "py_started", "mode": mode})

        def do_calls() -> None:
            r = node.call("aa_ts", "ts_ping", {}, timeout=10.0)
            emit({
                "event": "lazy_called_ts_ping",
                "ok": not r.is_error,
                "value": r.unwrap() if not r.is_error else r.error,
            })

        act_when_connected(node, "aa_ts", do_calls)

    try:
        while True:
            time.sleep(0.2)
    except KeyboardInterrupt:
        pass
    finally:
        node.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
