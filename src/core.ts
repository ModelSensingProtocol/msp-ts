/**
 * MSP 线格式核心 —— 与 Python 参考实现（msp-py）字节级对齐。
 *
 * 三个契约（全部来自对参考实现的逐行核对，不是猜的）：
 *   1. Signal 序列化**恒输出全部 8 个顶层字段**，None 写成 null
 *      （Python `to_dict` 不做键省略；宽容读取的对称面是「原样回带未知字段」）。
 *   2. TCP 分帧 = 4 字节大端长度前缀 + UTF-8 JSON 正文。
 *   3. 通配符只允许出现在模式末尾：`*` 恰好一段，`**` 零或多段
 *      （`system.**` 连 `system` 本身也匹配）。
 */

// ----------------------------------------------------------------------

export const SignalType = {
  HELLO: "hello",
  ACK: "ack",
  SIGNAL: "signal",
  TOOL_CALL: "tool_call",
  TOOL_RESULT: "tool_result",
  MANIFEST_UPDATE: "manifest_update",
  PING: "ping",
  PONG: "pong",
  ERROR: "error",
} as const;

export type SignalTypeValue = (typeof SignalType)[keyof typeof SignalType];

/** MSP 的统一信号结构。extras 收留线上未知顶层键，编码时原样带回。 */
export interface Signal {
  type: string;
  source: string;
  pattern: string | null;
  target: string | null;
  path: string | null;
  reqid: string | null;
  payload: Record<string, unknown>;
  timestamp: number;
  extras: Record<string, unknown>;
}

export function makeSignal(
  type: string,
  source: string,
  opts: {
    target?: string | null;
    path?: string | null;
    reqid?: string | null;
    payload?: Record<string, unknown>;
  } = {},
): Signal {
  return {
    type,
    source,
    pattern: null,
    target: opts.target ?? null,
    path: opts.path ?? null,
    reqid: opts.reqid ?? null,
    payload: opts.payload ?? {},
    timestamp: Date.now() / 1000,
    extras: {},
  };
}

/** 固定键序只为日志可读；JSON 解析方本不关心键序。 */
export function encodeSignal(sig: Signal): Buffer {
  const out: Record<string, unknown> = {
    type: sig.type,
    source: sig.source,
    pattern: sig.pattern,
    target: sig.target,
    path: sig.path,
    reqid: sig.reqid,
    payload: sig.payload,
    timestamp: sig.timestamp,
    ...sig.extras,
  };
  return Buffer.from(JSON.stringify(out), "utf-8");
}

export function decodeSignal(data: Buffer | Uint8Array): Signal {
  const raw = JSON.parse(Buffer.from(data).toString("utf-8")) as Record<string, unknown>;
  if (typeof raw.type !== "string" || typeof raw.source !== "string") {
    throw new Error("非法 Signal：缺少 type / source");
  }
  // timestamp 仅接受数值，坏类型退回当前时间（对齐 Python 的宽容读取）
  const ts = typeof raw.timestamp === "number" ? raw.timestamp : Date.now() / 1000;
  const payload =
    raw.payload !== null && typeof raw.payload === "object" && !Array.isArray(raw.payload)
      ? (raw.payload as Record<string, unknown>)
      : {};
  const known = new Set([
    "type", "source", "pattern", "target", "path", "reqid", "payload", "timestamp",
  ]);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!known.has(k)) extras[k] = v;
  }
  return {
    type: raw.type,
    source: raw.source,
    pattern: (raw.pattern as string | null) ?? null,
    target: (raw.target as string | null) ?? null,
    path: (raw.path as string | null) ?? null,
    reqid: (raw.reqid as string | null) ?? null,
    payload,
    timestamp: ts,
    extras,
  };
}

// ----------------------------------------------------------------------

/** 4 字节大端长度前缀的流式解码器。push 任意分块，弹出完整帧。 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > 64 * 1024 * 1024) {
        throw new Error(`帧长度超限（${len} 字节），流已损坏`);
      }
      if (this.buf.length < 4 + len) break;
      frames.push(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
    return frames;
  }
}

export function frameMessage(data: Buffer | Uint8Array): Buffer {
  const body = Buffer.from(data);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

// ----------------------------------------------------------------------

/**
 * 通配符匹配（与 `protocol/matcher.py` 同语义）：
 *   精确        `ai.state` 只匹配 `ai.state`
 *   `*` 末尾    `ai.*` 匹配 `ai.state`，不匹配 `ai.state.sub`（恰好一段）
 *   `**` 末尾   `system.**` 匹配 `system` 及其下任意层（零或多段）
 */
export function patternMatches(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  if (pattern.endsWith(".**")) {
    const base = pattern.slice(0, -3);
    return path === base || path.startsWith(base + ".");
  }
  if (pattern.endsWith(".*")) {
    const base = pattern.slice(0, -2);
    const rest = path.startsWith(base + ".") ? path.slice(base.length + 1) : null;
    return rest !== null && rest.length > 0 && !rest.includes(".");
  }
  return false;
}

// ----------------------------------------------------------------------

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputTypes?: string[];
  annotations?: Record<string, unknown>;
}

/** 能力清单。版本号在每次变更时 +1，对端靠它判断「清单变没变」。 */
export class Manifest {
  version = 0;
  patterns: string[] = [];
  patternMetadata: Record<string, unknown> = {};
  capabilities: string[] = [];
  signals: { path: string; schema?: Record<string, unknown>; description?: string }[] = [];
  tools: ToolSpec[] = [];
  resources: unknown[] = [];
  prompts: unknown[] = [];
  clientCapabilities = { sampling: false, elicitation: false, roots: false };

  addTool(spec: ToolSpec): void {
    const existing = this.tools.findIndex((t) => t.name === spec.name);
    if (existing >= 0) this.tools[existing] = spec;
    else this.tools.push(spec);
    this.version += 1;
  }

  addSignal(path: string, opts: { schema?: Record<string, unknown>; description?: string } = {}): void {
    if (!this.signals.some((s) => s.path === path)) {
      this.signals.push({ path, schema: opts.schema, description: opts.description });
      this.version += 1;
    }
  }

  toDict(): Record<string, unknown> {
    return {
      version: this.version,
      patterns: [...this.patterns],
      patternMetadata: { ...this.patternMetadata },
      capabilities: [...this.capabilities].sort(),
      signals: this.signals.map((s) => ({
        path: s.path,
        ...(s.schema && Object.keys(s.schema).length > 0 ? { schema: s.schema } : {}),
        ...(s.description ? { description: s.description } : {}),
      })),
      tools: this.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? {},
        outputTypes: t.outputTypes ?? [],
        annotations: t.annotations ?? {},
      })),
      resources: [...this.resources],
      prompts: [...this.prompts],
      clientCapabilities: { ...this.clientCapabilities },
    };
  }
}

// ----------------------------------------------------------------------

/** 工具调用结果：错误即值，不抛异常（对齐 ToolResult 的语义）。 */
export class ToolResult {
  readonly content: unknown[];
  readonly structuredContent?: unknown;
  readonly error?: string;

  constructor(content: unknown[], structuredContent?: unknown, error?: string) {
    this.content = content;
    this.structuredContent = structuredContent;
    this.error = error;
  }

  get is_error(): boolean {
    return typeof this.error === "string" && this.error.length > 0;
  }

  unwrap(): unknown {
    if (this.is_error) {
      throw new Error(this.error);
    }
    return this.structuredContent !== undefined ? this.structuredContent : this.content;
  }
}
