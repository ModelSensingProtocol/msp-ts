/** 互通测试的共用夹具：等条件、起真 Python 节点。 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 轮询等待条件成立；超时抛出带上下文的错误。 */
export function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
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

export interface PyNode {
  child: ChildProcess;
  events: any[];
  dir: string;
}

/**
 * 起一个 Python 参考实现节点（`py_node.py`），返回它的临时目录与事件流。
 *
 * 用真进程而不是模拟：互通的价值就在于「对面是一份独立实现」，
 * 同进程 mock 会把两侧的假设悄悄对齐，测不出线格式分歧。
 */
export function spawnPy(mode: "eager" | "lazy"): PyNode {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `msp_ts_${mode}_`));
  const child = spawn("python", [path.join(import.meta.dirname, "py_node.py"), dir, mode], {
    stdio: ["ignore", "pipe", "pipe"],
  });

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

/** 等 Python 侧打出 py_started，确认它已经写完声明、开始监听。 */
export function waitPyStarted(py: PyNode, timeoutMs = 15_000): Promise<void> {
  return waitFor(() => py.events.some((e) => e.event === "py_started"), timeoutMs, "py_started");
}
