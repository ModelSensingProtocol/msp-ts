# msp-ts

MSP（Model Sensing Protocol）的 **TypeScript 实现**，与 Python 参考实现（`msp-py`）**线格式互通**：
同一个共享目录里，TS 节点和 Python 节点互相发现、互相调用工具、互相订阅广播。

当前是 **M1 + M2**（线格式 + 节点层），能跑真实互通；模式层与 MCP 桥还没做。

## 零依赖，直接跑

```bash
node --test "test/*.test.ts"     # 19 个用例，其中 10 个是与真 Python 进程的互通
```

不需要 `npm install`、不需要构建：Node ≥ 22.6 原生剥离类型，`src/*.ts` 直接被执行。
（`npm i` 只为 `npm run typecheck` 与将来发布。）

## 用法

```ts
import { MSPNode } from "./src/node.ts";

const node = new MSPNode("ts_b", { nodesDir: "/tmp/msp-nodes" });

node.tool("add", "加法", ({ a, b }) => Number(a) + Number(b), {
  type: "object",
  properties: { a: { type: "integer" }, b: { type: "integer" } },
  required: ["a", "b"],
});

node.on("notify.**", (sig) => console.log(sig.path, sig.payload));   // 通配符订阅
node.declareSignal("sensor.ts.temp");

await node.start();                                   // 监听 + 宣告 + 发现 + eager 拨号
const r = await node.call("py_a", "py_echo", { msg: "hi" });
console.log(r.unwrap());                              // { echo: "hi" }
node.publish("sensor.ts.temp", { celsius: 26.5 });    // 广播给所有已连对端
```

## 与 Python 参考实现的对应

| msp-py | msp-ts | 说明 |
|---|---|---|
| `Signal.to_dict()`（8 字段全量 + extras） | `encodeSignal` / `decodeSignal` | None 写成 `null`，未知顶层键收进 `extras` 原样回带 |
| `TCPTransport` 4 字节大端长度前缀 | `FrameDecoder` / `frameMessage` | 流式重组，跨分块/粘包都有用例 |
| `pattern_matches`（`*` / `**`） | `patternMatches` | 同语义：`system.**` 连 `system` 本身也匹配 |
| `_finish_handshake` 去重仲裁 | `finishHandshake` | 规范方向 = node_id 较小一方 outbound；非规范方向关闭 |
| `DirectoryScan` / `DirectoryWrite` | `DirectoryDiscovery` / `DirectoryPresence` | 同一份声明文件格式；租约 30s、续租 5s |
| `_heartbeat_loop`（15s/45s） | `heartbeat()` | 回 PONG；超时判死 |
| `ToolResult`（错误即值） | `ToolResult` | `is_error` + `unwrap()` |

**有意不同的一处**：schema 不做签名自省。TS 的类型运行时不存在，`inputSchema` 显式传入
（正式版建议接 Zod/TypeBox，让 schema 成为唯一真相源）。

## 互通测试测了什么

`test/interop.test.ts` 起真 Python 进程（`interop/py_node.py`），跑两个场景：

| 场景 | 覆盖 |
|---|---|
| **eager**：`py_a` 用 FULL_PEER，规范方向是它拨 `ts_b` | TS 接受入站 → 握手 → 去重仲裁；TS 调 py；py 调 TS；双向广播；清单交换 |
| **lazy**：`zz_lazy` 用 LOCAL_TOOL（只宣告不发现），规范方向是 `aa_ts` 拨它 | TS 主动拨号 + 出站握手；TS 调 lazy 工具；**反向调用**；错误即值 |

## 发现的参考实现缺陷（已绕开，未修复）

**`on_connected` 回调在 ACK 之前触发。** `MSPProtocol._finish_handshake` 里先 `for cb in self._on_connected: cb(...)`，
`handshake_inbound` 之后才 `conn.send(ACK)`。于是回调里若 `call()`，线上顺序变成：

```
HELLO → tool_call →（回调阻塞等结果）→ ACK
```

对端在 `handshake_outbound` 里等 ACK，收到 `tool_call` 判「握手失败」→ 断开 → 双方死锁到超时。
**Python 对 Python 也一样中招**（只要任一节点在 `on_connected` 里 `call`）。

两个处理：
1. 互通脚本改用「后台线程等连接进表」再动作（`interop/py_node.py` 的 `act_when_connected`）；
2. msp-ts 侧做**宽容握手**：等 ACK 期间收到非 ACK 帧就临时登记该连接并立即处理，
   让对端能继续走到发 ACK 那一步（`protocol.ts` 的 `handshakeOutbound`）。

建议参考实现把 `conn.send(ACK)` 移到触发回调之前——这是协议层的顺序问题，不是用法问题。

## 还没做的

| 里程碑 | 内容 |
|---|---|
| M3 | `msp/multi-round`、`msp/task` 模式 |
| M4 | MCP 桥（吃官方 `@modelcontextprotocol/sdk`，挂 MCP server 的工具） |
| M5 | 浏览器 profile（WS-only + 手动发现；浏览器没有 TCP/目录发现） |

另外还没接：`grants` 授权表、`settle()`（TS 里等连接天然是 await，语义可简化）。
