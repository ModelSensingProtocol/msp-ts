/** 线格式单元测试：分帧、通配符、Signal 编解码往返。 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  decodeSignal,
  encodeSignal,
  FrameDecoder,
  frameMessage,
  makeSignal,
  patternMatches,
} from "../src/core.ts";

// ----------------------------------------------------------------------

test("分帧：跨 TCP 分块重组", () => {
  const msg = Buffer.from("hello world");
  const framed = frameMessage(msg);
  const dec = new FrameDecoder();
  // 按 3 字节一块喂进去，模拟网络分片
  const out: Buffer[] = [];
  for (let i = 0; i < framed.length; i += 3) {
    out.push(...dec.push(framed.subarray(i, i + 3)));
  }
  assert.equal(out.length, 1);
  assert.ok(out[0].equals(msg));
});

test("分帧：多条消息粘包", () => {
  const dec = new FrameDecoder();
  const a = frameMessage(Buffer.from("aaa"));
  const b = frameMessage(Buffer.from("bbbb"));
  const out = dec.push(Buffer.concat([a, b]));
  assert.deepEqual(out.map((f) => f.toString()), ["aaa", "bbbb"]);
});

test("分帧：长度前缀是大端 4 字节", () => {
  const framed = frameMessage(Buffer.from("x"));
  assert.equal(framed.readUInt32BE(0), 1);
});

// ----------------------------------------------------------------------

test("通配符：精确匹配", () => {
  assert.ok(patternMatches("ai.state", "ai.state"));
  assert.ok(!patternMatches("ai.state", "ai.state.sub"));
  assert.ok(!patternMatches("ai.state", "ai"));
});

test("通配符：* 恰好一段", () => {
  assert.ok(patternMatches("ai.*", "ai.state"));
  assert.ok(!patternMatches("ai.*", "ai.state.sub"));
  assert.ok(!patternMatches("ai.*", "ai"));
});

test("通配符：** 零或多段", () => {
  assert.ok(patternMatches("system.**", "system"));
  assert.ok(patternMatches("system.**", "system.file.modified"));
  assert.ok(!patternMatches("system.**", "systemx"));
  assert.ok(patternMatches("notify.**", "notify.web.download"));
});

// ----------------------------------------------------------------------

test("Signal 往返：8 个字段全量保留", () => {
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
  assert.ok(typeof decoded.timestamp === "number");
  // None 字段在线上是 null（对齐 Python to_dict 的全量输出）
  assert.equal(decoded.pattern, null);
  assert.equal(decoded.path, null);
});

test("Signal 编码：None 字段写成 null（与 Python 字节级一致的形状）", () => {
  const sig = makeSignal("hello", "a");
  const obj = JSON.parse(encodeSignal(sig).toString("utf-8"));
  assert.deepEqual(Object.keys(obj), [
    "type", "source", "pattern", "target", "path", "reqid", "payload", "timestamp",
  ]);
  assert.equal(obj.pattern, null);
  assert.deepEqual(obj.payload, {});
});

test("Signal 解码：未知顶层字段收留进 extras 并原样带回", () => {
  const raw = Buffer.from(JSON.stringify({
    type: "signal", source: "py", path: "a.b", payload: { v: 1 },
    timestamp: 123.5, futureField: { x: 1 },
  }));
  const decoded = decodeSignal(raw);
  assert.deepEqual(decoded.extras, { futureField: { x: 1 } });
  const back = JSON.parse(encodeSignal(decoded).toString("utf-8"));
  assert.deepEqual(back.futureField, { x: 1 });
});
