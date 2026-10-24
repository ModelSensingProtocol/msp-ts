/**
 * 最小可运行示例：起两个节点，验证发现、工具调用、广播。
 *
 *     node examples/hello.ts
 *
 * 跑完自己退出，临时目录也清掉，不留后台进程。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MSPNode } from "../src/index.ts";

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

const nodesDir = fs.mkdtempSync(path.join(os.tmpdir(), "msp_hello_"));
const received: { path: string; payload: unknown }[] = [];

// ── 节点 A：提供工具、发广播 ───────────────────────────────────────────
const a = new MSPNode("ts_hello", { nodesDir });
a.tool("echo", "回声：把收到的 msg 原样返回", ({ msg }) => ({ echo: msg }), {
  type: "object",
  properties: { msg: { type: "string" } },
  required: ["msg"],
});
a.declareSignal("sensor.ts.tick", "示例心跳信号");

await a.start();
const declPath = path.join(nodesDir, "ts_hello.json");
console.log("① 节点 A 已启动");
console.log("   声明文件:", declPath);
console.log("   内容:", fs.readFileSync(declPath, "utf-8").replace(/\s+/g, " "));
console.log("   工具:", a.manifest.tools.map((t) => t.name).join(", "));

// ── 节点 B：订阅 A 的广播、调用 A 的工具 ──────────────────────────────
const b = new MSPNode("ts_peer", { nodesDir });
b.on("sensor.**", (sig) => received.push({ path: sig.path!, payload: sig.payload }));
await b.start();
console.log("\n② 节点 B 已启动，等待发现 A…");

await waitFor(() => b.connections().includes("ts_hello"), 10_000, "B 连上 A");
console.log("   已连接。B 从 A 的清单里看到工具:",
  ((b.peerManifest("ts_hello") as any)?.tools ?? []).map((t: any) => t.name).join(", "));

const r = await b.call("ts_hello", "echo", { msg: "你好，MSP" });
console.log("\n③ B 调 A 的 echo:", JSON.stringify(r.unwrap()));

a.publish("sensor.ts.tick", { seq: 1, celsius: 26.5 });
await waitFor(() => received.length > 0, 5_000, "B 收到广播");
console.log("④ B 收到 A 的广播:", JSON.stringify(received[0]));

// ── 收尾 ──────────────────────────────────────────────────────────────
a.stop();
b.stop();
fs.rmSync(nodesDir, { recursive: true, force: true });
console.log("\n完成：两个节点已停止，临时发现目录已清理。");
