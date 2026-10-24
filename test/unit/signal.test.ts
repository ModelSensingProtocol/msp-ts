/** Signal 编解码：与 Python `to_dict` 的线格式契约。 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { decodeSignal, encodeSignal, makeSignal } from "../../src/core/signal.ts";

test("往返：8 个字段全量保留", () => {
  const sig = makeSignal("tool_call", "ts_b", {
    target: "py_a",
    reqid: "r1",
    payload: { tool: "x", args: { a: 1 } },
  });
  const decoded = decodeSignal(encodeSignal(sig));
  assert.equal(decoded.type, "tool_call");
  assert.equal(decoded.source, "ts_b");
  assert.equal(decoded.target, "py_a");
  assert.equal(decoded.reqid, "r1");
  assert.deepEqual(decoded.payload, { tool: "x", args: { a: 1 } });
  assert.equal(typeof decoded.timestamp, "number");
  // None 字段在线上是 null（对齐 Python to_dict 的全量输出）
  assert.equal(decoded.pattern, null);
  assert.equal(decoded.path, null);
});

test("编码：None 写成 null，键序固定", () => {
  const sig = makeSignal("hello", "a");
  const obj = JSON.parse(encodeSignal(sig).toString("utf-8"));
  assert.deepEqual(Object.keys(obj), [
    "type", "source", "pattern", "target", "path", "reqid", "payload", "timestamp",
  ]);
  assert.equal(obj.pattern, null);
  assert.deepEqual(obj.payload, {});
});

test("解码：未知顶层字段收进 extras 并原样带回", () => {
  const raw = Buffer.from(JSON.stringify({
    type: "signal", source: "py", path: "a.b", payload: { v: 1 },
    timestamp: 123.5, futureField: { x: 1 },
  }));
  const decoded = decodeSignal(raw);
  assert.deepEqual(decoded.extras, { futureField: { x: 1 } });
  const back = JSON.parse(encodeSignal(decoded).toString("utf-8"));
  assert.deepEqual(back.futureField, { x: 1 });
});

test("解码：坏 timestamp 退回当前时间（宽容读取）", () => {
  const raw = Buffer.from(JSON.stringify({ type: "ping", source: "py", timestamp: "bad" }));
  const decoded = decodeSignal(raw);
  assert.equal(typeof decoded.timestamp, "number");
});
