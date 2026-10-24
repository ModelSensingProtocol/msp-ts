/**
 * 互通场景二（lazy）：Python 用 LOCAL_TOOL（只宣告、不发现、只接受入站）。
 *
 * aa_ts < zz_lazy，规范方向是 TS 拨 —— 覆盖 TS 的**出站**路径：
 * 发现 → 拨号 → 出站握手 → 被 Python 反向调用 → 错误即值。
 */

import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";

import { MSPNode } from "../../src/node.ts";
import { spawnPy, waitFor, waitPyStarted, type PyNode } from "../support/harness.ts";

describe("场景二：lazy Python（aa_ts 主动拨 zz_lazy）", () => {
  let py: PyNode;
  let ts: MSPNode;

  before(async () => {
    py = spawnPy("lazy");
    await waitPyStarted(py);

    ts = new MSPNode("aa_ts", { nodesDir: py.dir });
    ts.tool("ts_ping", "探针", () => "pong");
    await ts.start();
  });

  after(() => {
    ts?.stop();
    py?.child.kill();
  });

  test("TS 发现声明并主动拨号（规范方向）", async () => {
    await waitFor(() => ts.connections().includes("zz_lazy"), 20_000, "aa_ts 连上 zz_lazy");
  });

  test("TS 调 lazy 工具（lazy_double）", async () => {
    const r = await ts.call("zz_lazy", "lazy_double", { x: 21 }, 10_000);
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
    const r = await ts.call("zz_lazy", "no_such_tool", {}, 10_000);
    assert.ok(r.is_error);
    assert.match(r.error ?? "", /未知工具/);
  });
});
