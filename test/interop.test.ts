/**
 * 互通端到端：TS 节点 ↔ Python 参考实现节点，真实 TCP、真实共享目录。
 *
 * 场景一 eager：Python 用 FULL_PEER（会主动发现并拨号）。node_id 排序上
 *   py_a < ts_b，规范方向是 py 拨——所以这条同时测了「TS 的非规范拨号被
 *   无害拒绝」和「TS 接受入站 + 握手 + 去重仲裁」。
 *
 * 场景二 lazy：Python 用 LOCAL_TOOL（只宣告、不发现、只接受入站）。
 *   aa_ts < zz_lazy，规范方向是 TS 拨——这条测「TS 主动拨号 + 出站握手」，
 *   以及连接建立后被 Python 侧反向调用。
 */

import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import { MSPNode } from "../src/node.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (predicate()) {
        clearInterval(tick);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`等待超时: ${what}`));
      }
    }, 50);
  });
}

/** 起 Python 节点并把 stdout 的 JSON 行收进 events。 */
function spawnPy(mode: string): { child: ChildProcess; events: any[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `msp_ts_${mode}_`));
  const child = spawn("python", [
    path.join(HERE, "..", "interop", "py_node.py"), dir, mode,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const events: any[] = [];
  let buf = "";
  child.stdout!.setEncoding("utf-8");
  child.stdout!.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        events.push(JSON.parse(t));
      } catch {
        /* 非 JSON 行（Python 日志）忽略 */
      }
    }
  });
  child.stderr!.setEncoding("utf-8");
  child.stderr!.on("data", (c: string) => process.stderr.write(`[py] ${c}`));
  return { child, events, dir };
}

// ======================================================================

describe("场景一：eager Python（py_a 主动拨 ts_b）", () => {
  const py = spawnPy("eager");
  const received: { path: string; payload: any }[] = [];
  let ts: MSPNode | null = null;

  before(async () => {
    await waitFor(() => py.events.some((e) => e.event === "py_started"), 15_000, "py_started");

    ts = new MSPNode("ts_b", { nodesDir: py.dir });
    ts.tool("ts_add", "加法", async ({ a, b }) =>
      Number(a) + Number(b), {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
      });
    ts.on("notify.**", (sig) => received.push({ path: sig.path!, payload: sig.payload }));
    await ts.start();
  });

  after(() => {
    ts?.stop();
    py.child.kill();
  });

  test("互相发现并建立连接（Python 侧规范拨号）", async () => {
    await waitFor(() => ts!.connections().includes("py_a"), 20_000, "ts_b 连上 py_a");
  });

  test("TS 调 Python 工具（py_echo）", async () => {
    const r = await ts!.call("py_a", "py_echo", { msg: "hi" }, 10_000);
    assert.ok(!r.is_error, r.error);
    assert.deepEqual(r.unwrap(), { echo: "hi" });
  });

  test("Python 调 TS 工具（ts_add，连上即回调）", async () => {
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
    const r = received.find((x) => x.path === "notify.from_py.hello")!;
    assert.equal(r.payload.greeting, "hi from python");
  });

  test("广播：TS publish → Python on(sensor.ts.**) 收到", async () => {
    ts!.declareSignal("sensor.ts.temp");
    ts!.publish("sensor.ts.temp", { celsius: 26.5 });
    await waitFor(
      () => py.events.some((e) => e.event === "py_received" && e.path === "sensor.ts.temp"),
      10_000, "py 收到 sensor.ts.temp",
    );
  });

  test("握手交换了清单：TS 能看到 py 的工具声明", async () => {
    await waitFor(() => ts!.connections().includes("py_a"), 5_000, "已连接");
    const m = ts!.peerManifest("py_a") as any;
    assert.ok(m, "应有 py_a 的 manifest");
    const names = (m.tools as any[]).map((t) => t.name);
    assert.ok(names.includes("py_echo"), `tools=${JSON.stringify(names)}`);
  });
});

// ======================================================================

describe("场景二：lazy Python（aa_ts 主动拨 zz_lazy）", () => {
  const py = spawnPy("lazy");
  let ts: MSPNode | null = null;

  before(async () => {
    await waitFor(() => py.events.some((e) => e.event === "py_started"), 15_000, "py_started");

    ts = new MSPNode("aa_ts", { nodesDir: py.dir });
    ts.tool("ts_ping", "探针", () => "pong");
    await ts.start();
  });

  after(() => {
    ts?.stop();
    py.child.kill();
  });

  test("TS 发现 zz_lazy 的声明并主动拨号（规范方向）", async () => {
    await waitFor(() => ts!.connections().includes("zz_lazy"), 20_000, "aa_ts 连上 zz_lazy");
  });

  test("TS 调 lazy 工具（lazy_double）", async () => {
    const r = await ts!.call("zz_lazy", "lazy_double", { x: 21 }, 10_000);
    assert.ok(!r.is_error, r.error);
    assert.deepEqual(r.unwrap(), { doubled: 42 });
  });

  test("连接是双向的：lazy Python 反向调用 ts_ping", async () => {
    await waitFor(
      () => py.events.some((e) => e.event === "lazy_called_ts_ping"),
      15_000, "lazy 调 ts_ping",
    );
    const ev = py.events.find((e) => e.event === "lazy_called_ts_ping")!;
    assert.ok(ev.ok, JSON.stringify(ev));
    assert.equal(ev.value, "pong");
  });

  test("错误即值：调不存在的工具得到 error 而不是异常", async () => {
    const r = await ts!.call("zz_lazy", "no_such_tool", {}, 10_000);
    assert.ok(r.is_error);
    assert.match(r.error ?? "", /未知工具/);
  });
});
