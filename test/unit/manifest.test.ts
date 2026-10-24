/** Manifest 序列化形状与命名文法。 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Manifest } from "../../src/core/manifest.ts";
import { isValidNodeId, isValidSignalPath, isValidToolName } from "../../src/core/grammar.ts";

test("Manifest.toDict：9 个容器字段齐全（与 Python 同形）", () => {
  const m = new Manifest();
  const d = m.toDict();
  assert.deepEqual(Object.keys(d).sort(), [
    "capabilities", "clientCapabilities", "patternMetadata", "patterns",
    "prompts", "resources", "signals", "tools", "version",
  ]);
});

test("Manifest：工具与信号登记会推进 version", () => {
  const m = new Manifest();
  const v0 = m.version;
  m.addTool({ name: "echo", description: "回声" });
  assert.ok(m.version > v0, "登记工具必须递增 version（对端据此判断清单变没变）");
  const v1 = m.version;
  m.addSignal("sensor.temp");
  assert.ok(m.version > v1);
});

test("Manifest：工具描述按 ToolDescriptor 形状输出", () => {
  const m = new Manifest();
  m.addTool({ name: "echo", description: "回声", inputSchema: { type: "object" } });
  const tool = (m.toDict().tools as any[])[0];
  assert.deepEqual(Object.keys(tool).sort(), [
    "annotations", "description", "inputSchema", "name", "outputTypes",
  ]);
});

test("文法：工具名/节点名不允许点号与大写", () => {
  assert.ok(isValidToolName("get_weather"));
  assert.ok(!isValidToolName("esp.led"), "点号是 path 的分隔符，工具名里非法");
  assert.ok(!isValidToolName("GetWeather"), "大写非法");
  assert.ok(isValidNodeId("esp32_a"));
  assert.ok(isValidSignalPath("sensor.soil.moisture"));
  assert.ok(!isValidSignalPath("sensor..moisture"));
});
