/**
 * 互通场景一（eager）：Python 用 FULL_PEER，会主动发现并拨号。
 *
 * node_id 排序上 py_a < ts_b，规范方向是 Python 拨 —— 所以这条同时覆盖：
 *   - TS 接受入站、握手、去重仲裁（TS 自己的非规范拨号被无害拒绝）；
 *   - 双向工具调用；双向广播；清单交换。
 */

import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";

import { MSPNode } from "../../src/node.ts";
import { spawnPy, waitFor, waitPyStarted, type PyNode } from "../support/harness.ts";

describe("场景一：eager Python（py_a 主动拨 ts_b）", () => {
  let py: PyNode;
  let ts: MSPNode;
  const received: { path: string; payload: any }[] = [];

  before(async () => {
    py = spawnPy("eager");
    await waitPyStarted(py);

    ts = new MSPNode("ts_b", { nodesDir: py.dir });
    ts.tool("ts_add", "加法", ({ a, b }) => Number(a) + Number(b), {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" } },
      required: ["a", "b"],
    });
    ts.on("notify.**", (sig) => received.push({ path: sig.path!, payload: sig.payload }));
    await ts.start();
  });

  after(() => {
    ts?.stop();
    py?.child.kill();
  });

  test("互相发现并建立连接（Python 侧规范拨号）", async () => {
    await waitFor(() => ts.connections().includes("py_a"), 20_000, "ts_b 连上 py_a");
  });

  test("握手交换了清单：TS 能看到 py 的工具声明", async () => {
    const m = ts.peerManifest("py_a") as any;
    assert.ok(m, "应有 py_a 的 manifest");
    const names = (m.tools as any[]).map((t) => t.name);
    assert.ok(names.includes("py_echo"), `tools=${JSON.stringify(names)}`);
  });

  test("TS 调 Python 工具（py_echo）", async () => {
    const r = await ts.call("py_a", "py_echo", { msg: "hi" }, 10_000);
    assert.ok(!r.is_error, r.error);
    assert.deepEqual(r.unwrap(), { echo: "hi" });
  });

  test("Python 调 TS 工具（ts_add）", async () => {
    await waitFor(
      () => py.events.some((e) => e.event === "py_called_ts_add"),
      20_000, "py 调 ts_add",
    );
    const ev = py.events.find((e) => e.event === "py_called_ts_add")!;
    assert.ok(ev.ok, JSON.stringify(ev));
    assert.equal(ev.value, 5);
  });

  test("广播：Python publish → TS on(notify.**) 收到", async () => {
    await waitFor(() => received.some((r) => r.path === "notify.from_py.hello"), 10_000,
      "TS 收到 notify.from_py.hello");
    assert.equal(received.find((x) => x.path === "notify.from_py.hello")!.payload.greeting,
      "hi from python");
  });

  test("广播：TS publish → Python on(sensor.ts.**) 收到", async () => {
    ts.declareSignal("sensor.ts.temp");
    ts.publish("sensor.ts.temp", { celsius: 26.5 });
    await waitFor(
      () => py.events.some((e) => e.event === "py_received" && e.path === "sensor.ts.temp"),
      10_000, "py 收到 sensor.ts.temp",
    );
  });
});
