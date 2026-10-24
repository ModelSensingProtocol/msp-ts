/** 分帧：4 字节大端长度前缀的流式重组。 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { FrameDecoder, frameMessage } from "../../src/protocol/framing.ts";

test("跨 TCP 分块重组", () => {
  const msg = Buffer.from("hello world");
  const framed = frameMessage(msg);
  const dec = new FrameDecoder();
  const out: Buffer[] = [];
  for (let i = 0; i < framed.length; i += 3) {
    out.push(...dec.push(framed.subarray(i, i + 3)));
  }
  assert.equal(out.length, 1);
  assert.ok(out[0].equals(msg));
});

test("多条消息粘包", () => {
  const dec = new FrameDecoder();
  const a = frameMessage(Buffer.from("aaa"));
  const b = frameMessage(Buffer.from("bbbb"));
  const out = dec.push(Buffer.concat([a, b]));
  assert.deepEqual(out.map((f) => f.toString()), ["aaa", "bbbb"]);
});

test("长度前缀是大端 4 字节", () => {
  const framed = frameMessage(Buffer.from("x"));
  assert.equal(framed.readUInt32BE(0), 1);
});
