/**
 * Structured, redacting logger.
 *
 * Rules (tested in test/log.test.ts):
 *   • Any 32-byte hex string is treated as key material and redacted unless it
 *     sits under an explicitly allow-listed field name (txHash, blockHash,
 *     hash). Private keys and transaction hashes have the same shape, so the
 *     allow-list is by field, never by value.
 *   • URLs are reduced to their origin: RPC providers put API keys in the path
 *     and userinfo, and a full URL in a log line is a leaked credential.
 *   • Bearer tokens / Authorization values are redacted.
 *   • Fields literally named like secrets (privateKey, secret, jwt, token,
 *     authorization, password) are redacted regardless of value.
 * The keeper's private key never enters the logger at all (config omits it
 * from its serialised form), so redaction is defence in depth, not the wall.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const HASH_FIELDS = new Set(["txHash", "blockHash", "hash", "transactionHash"]);
const SECRET_FIELDS = /^(.*privatekey|.*secret|.*jwt|.*token|authorization|password|.*apikey)$/i;

const HEX32 = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const URL_RE = /\b(https?|wss?):\/\/[^\s"'<>]+/g;

export const REDACTED = "[redacted]";

export function redactString(s: string): string {
  return s
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(URL_RE, (m) => {
      try {
        const u = new URL(m);
        // Origin only: path, query and userinfo are where API keys live.
        return `${u.protocol}//${u.host}/…`;
      } catch {
        return REDACTED;
      }
    })
    .replace(HEX32, `0x${REDACTED}`);
}

export function redactValue(v: unknown, key?: string, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (key !== undefined && SECRET_FIELDS.test(key)) return REDACTED;
  if (typeof v === "string") {
    if (key !== undefined && HASH_FIELDS.has(key) && /^0x[0-9a-fA-F]{64}$/.test(v)) return v;
    return redactString(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return v;
  if (v instanceof Error) {
    return { name: v.name, message: redactString(v.message) };
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x, undefined, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactValue(x, k, depth + 1);
    }
    return out;
  }
  return String(v);
}

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  [k: string]: unknown;
}

export type LogSink = (line: string, record: LogRecord) => void;

export class Logger {
  constructor(
    private readonly sink: LogSink,
    private readonly level: LogLevel = "info",
    private readonly bindings: Record<string, unknown> = {}
  ) {}

  child(bindings: Record<string, unknown>): Logger {
    return new Logger(this.sink, this.level, { ...this.bindings, ...bindings });
  }

  enabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.level];
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (!this.enabled(level)) return;
    const merged = redactValue({ ...this.bindings, ...(fields ?? {}) }) as Record<string, unknown>;
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      msg: redactString(msg),
      ...merged,
    };
    this.sink(JSON.stringify(record), record);
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit("error", msg, fields);
  }
}

export function stdoutSink(line: string): void {
  process.stdout.write(line + "\n");
}

/** Collecting sink for tests. */
export function memorySink(): { sink: LogSink; lines: string[]; records: LogRecord[] } {
  const lines: string[] = [];
  const records: LogRecord[] = [];
  return {
    sink: (line, record) => {
      lines.push(line);
      records.push(record);
    },
    lines,
    records,
  };
}
