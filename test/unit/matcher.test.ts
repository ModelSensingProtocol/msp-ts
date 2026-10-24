/** 通配符匹配：`*` 恰好一段，`**` 零或多段。 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { patternMatches } from "../../src/protocol/matcher.ts";

test("精确匹配", () => {
  assert.ok(patternMatches("ai.state", "ai.state"));
  assert.ok(!patternMatches("ai.state", "ai.state.sub"));
  assert.ok(!patternMatches("ai.state", "ai"));
});

test("* 恰好一段", () => {
  assert.ok(patternMatches("ai.*", "ai.state"));
  assert.ok(!patternMatches("ai.*", "ai.state.sub"));
  assert.ok(!patternMatches("ai.*", "ai"));
});

test("** 零或多段", () => {
  assert.ok(patternMatches("system.**", "system"));
  assert.ok(patternMatches("system.**", "system.file.modified"));
  assert.ok(!patternMatches("system.**", "systemx"));
  assert.ok(patternMatches("notify.**", "notify.web.download"));
});
