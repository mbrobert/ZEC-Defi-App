import { isAbsolute } from "node:path";
import type { Address, Hex } from "./types/evm.js";
import { isAddress } from "./types/evm.js";
import { redactString } from "./log.js";

/**
 * Env-driven keeper configuration with strict validation.
 *
 * Every failure names the offending variable. Rules that exist because they
 * were violated before (AUDIT-FINDINGS Lens E / Part 4):
 *   • numbers are parsed strictly — `Number("  ")` is 0 in JavaScript and a
 *     whitespace poll interval must not become a 0 ms busy loop;
 *   • every floor / interval / deadline must be > 0;
 *   • the store path must be absolute — a relative path resolves against the
 *     supervisor's cwd and a restart from another directory silently starts
 *     an empty store (losing the episode counter that keys idempotency);
 *   • the private key is validated for shape and NEVER serialised. `describe()`
 *     is the only thing that may be logged.
 *   • No health-factor thresholds are configurable here. The ladder comes from
 *     packages/shared (derived per asset); typing one in an env var is exactly
 *     the class of bug non-negotiable #2 forbids.
 */
export interface KeeperConfig {
  /** Base JSON-RPC endpoint. Redacted to origin in every log line. */
  rpcUrl: string;
  /** Chain id the RPC must report; anything else is fatal at startup. */
  chainId: number;
  /** Optional. Absent ⇒ observe-only: valuation + ladder run, dispatch is refused. */
  keeperPrivateKey?: Hex;
  /** OilskinAccountFactory — the source of `AccountCreated` discovery logs. */
  factoryAddress: Address;
  /** StrategyRouter — the keeper's only write target (via execAsKeeper). Required in keeper mode. */
  routerAddress?: Address;
  /** Half-width of the LP price band around the pool's live sqrtPrice, bps of price. */
  bandToleranceBps: number;
  /** Seconds a keeper transaction stays valid (router/venue deadline). */
  txDeadlineS: number;
  /** Absolute path of the keeper store (JSON). */
  storePath: string;
  healthPollMs: number;
  rpcDeadlineMs: number;
  /** Max accounts evaluated concurrently per tick. */
  concurrency: number;
  /** First block to scan for AccountCreated when the store has no cursor (the factory's deployment block). Required. */
  discoveryFromBlock: bigint;
  /** eth_getLogs window (blocks) per request. */
  discoveryChunkBlocks: number;
  /** Progress watchdog: a tick with no progress for this long is stalled. */
  watchdogStallMs: number;
  /** Exponential backoff ceiling after a stalled tick. */
  backoffMaxMs: number;
  /** Chainlink answer older than this is stale ⇒ valuation UNKNOWN. */
  priceMaxAgeS: number;
  /** Chainlink vs Aave-oracle disagreement beyond this ⇒ UNKNOWN. */
  oracleDeviationBps: number;
  /** Chain HF vs locally recomputed HF disagreement beyond this ⇒ UNKNOWN. */
  hfToleranceBps: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export class ConfigError extends Error {
  constructor(name: string, detail: string) {
    super(`config ${name}: ${detail}`);
    this.name = "ConfigError";
  }
}

/** Strict decimal literal: no whitespace, no exponent, no hex, no empty. */
const STRICT_NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

function readRaw(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  // Whitespace-only is a typo, not "unset": refuse rather than fall back.
  if (raw.length > 0 && raw.trim().length === 0) {
    throw new ConfigError(name, "is whitespace-only (would parse as 0)");
  }
  if (raw === "") return undefined;
  return raw;
}

function num(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  opts: { min?: number; max?: number; integer?: boolean } = {}
): number {
  const raw = readRaw(env, name);
  if (raw === undefined) return check(name, fallback, opts);
  if (!STRICT_NUMBER.test(raw)) throw new ConfigError(name, `not a strict decimal number: ${JSON.stringify(raw)}`);
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new ConfigError(name, `not finite: ${raw}`);
  return check(name, v, opts);
}

function check(
  name: string,
  v: number,
  opts: { min?: number; max?: number; integer?: boolean }
): number {
  if (opts.integer && !Number.isInteger(v)) throw new ConfigError(name, `must be an integer, got ${v}`);
  if (opts.min !== undefined && v < opts.min) throw new ConfigError(name, `must be ≥ ${opts.min}, got ${v}`);
  if (opts.max !== undefined && v > opts.max) throw new ConfigError(name, `must be ≤ ${opts.max}, got ${v}`);
  return v;
}

function bigintEnv(env: NodeJS.ProcessEnv, name: string, fallback: bigint | undefined): bigint {
  const raw = readRaw(env, name);
  if (raw === undefined) {
    if (fallback === undefined) throw new ConfigError(name, "is required");
    return fallback;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new ConfigError(name, `must be a non-negative integer: ${raw}`);
  return BigInt(raw);
}

function address(env: NodeJS.ProcessEnv, name: string): Address | undefined {
  const raw = readRaw(env, name);
  if (raw === undefined) return undefined;
  if (!isAddress(raw)) throw new ConfigError(name, "must be a 0x-prefixed 20-byte address");
  if (/^0x0{40}$/.test(raw)) throw new ConfigError(name, "must not be the zero address");
  return raw;
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, values: readonly T[], fallback: T): T {
  const raw = readRaw(env, name);
  if (raw === undefined) return fallback;
  if (!values.includes(raw as T)) throw new ConfigError(name, `must be one of ${values.join(", ")}`);
  return raw as T;
}

export const CONFIG_DEFAULTS = {
  chainId: 8453,
  healthPollMs: 30_000,
  rpcDeadlineMs: 10_000,
  concurrency: 4,
  discoveryChunkBlocks: 2_000,
  watchdogStallMs: 60_000,
  backoffMaxMs: 10 * 60_000,
  priceMaxAgeS: 3 * 3600,
  oracleDeviationBps: 300,
  hfToleranceBps: 100,
  bandToleranceBps: 100,
  txDeadlineS: 180,
} as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const rpcUrl = readRaw(env, "BASE_RPC_URL");
  if (rpcUrl === undefined) throw new ConfigError("BASE_RPC_URL", "is required");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rpcUrl);
  } catch {
    throw new ConfigError("BASE_RPC_URL", "is not a valid URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new ConfigError("BASE_RPC_URL", "must be http(s)");
  }

  const keyRaw = readRaw(env, "KEEPER_PRIVATE_KEY");
  let keeperPrivateKey: Hex | undefined;
  if (keyRaw !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(keyRaw)) {
      // Do not echo the value — even a malformed key is somebody's secret.
      throw new ConfigError("KEEPER_PRIVATE_KEY", "must be a 0x-prefixed 32-byte hex key");
    }
    if (/^0x0{64}$/.test(keyRaw)) throw new ConfigError("KEEPER_PRIVATE_KEY", "must not be zero");
    keeperPrivateKey = keyRaw as Hex;
  }

  const factoryAddress = address(env, "ACCOUNT_FACTORY_ADDRESS");
  if (!factoryAddress) throw new ConfigError("ACCOUNT_FACTORY_ADDRESS", "is required");

  const routerAddress = address(env, "STRATEGY_ROUTER_ADDRESS");
  if (keeperPrivateKey && !routerAddress) {
    throw new ConfigError("STRATEGY_ROUTER_ADDRESS", "is required when KEEPER_PRIVATE_KEY is set");
  }

  const storePath = readRaw(env, "STORE_PATH");
  if (storePath === undefined) throw new ConfigError("STORE_PATH", "is required");
  if (!isAbsolute(storePath)) throw new ConfigError("STORE_PATH", `must be absolute, got ${storePath}`);
  if (/\s/.test(storePath)) throw new ConfigError("STORE_PATH", "must not contain whitespace");

  const rpcDeadlineMs = num(env, "RPC_DEADLINE_MS", CONFIG_DEFAULTS.rpcDeadlineMs, { min: 1, integer: true });
  const healthPollMs = num(env, "HEALTH_POLL_MS", CONFIG_DEFAULTS.healthPollMs, { min: 1, integer: true });
  const watchdogStallMs = num(env, "WATCHDOG_STALL_MS", CONFIG_DEFAULTS.watchdogStallMs, { min: 1, integer: true });
  if (watchdogStallMs <= rpcDeadlineMs) {
    // A stall shorter than one RPC deadline would kill a tick that is merely
    // waiting on a single slow call — that is the elapsed-time bug again.
    throw new ConfigError("WATCHDOG_STALL_MS", `must exceed RPC_DEADLINE_MS (${rpcDeadlineMs})`);
  }

  return {
    rpcUrl,
    chainId: num(env, "CHAIN_ID", CONFIG_DEFAULTS.chainId, { min: 1, integer: true }),
    keeperPrivateKey,
    factoryAddress,
    routerAddress,
    bandToleranceBps: num(env, "BAND_TOLERANCE_BPS", CONFIG_DEFAULTS.bandToleranceBps, { min: 1, max: 5_000, integer: true }),
    txDeadlineS: num(env, "TX_DEADLINE_S", CONFIG_DEFAULTS.txDeadlineS, { min: 1, integer: true }),
    storePath,
    healthPollMs,
    rpcDeadlineMs,
    concurrency: num(env, "CONCURRENCY", CONFIG_DEFAULTS.concurrency, { min: 1, max: 64, integer: true }),
    // Required: the factory's deployment block. Without it a fresh store would
    // scan Base from genesis (tens of thousands of eth_getLogs windows).
    discoveryFromBlock: bigintEnv(env, "DISCOVERY_FROM_BLOCK", undefined),
    discoveryChunkBlocks: num(env, "DISCOVERY_CHUNK_BLOCKS", CONFIG_DEFAULTS.discoveryChunkBlocks, {
      min: 1,
      max: 10_000,
      integer: true,
    }),
    watchdogStallMs,
    backoffMaxMs: num(env, "BACKOFF_MAX_MS", CONFIG_DEFAULTS.backoffMaxMs, { min: 1, integer: true }),
    priceMaxAgeS: num(env, "PRICE_MAX_AGE_S", CONFIG_DEFAULTS.priceMaxAgeS, { min: 1, integer: true }),
    oracleDeviationBps: num(env, "ORACLE_DEVIATION_BPS", CONFIG_DEFAULTS.oracleDeviationBps, {
      min: 1,
      max: 5_000,
      integer: true,
    }),
    hfToleranceBps: num(env, "HF_TOLERANCE_BPS", CONFIG_DEFAULTS.hfToleranceBps, { min: 1, max: 5_000, integer: true }),
    logLevel: oneOf(env, "LOG_LEVEL", ["debug", "info", "warn", "error"] as const, "info"),
  };
}

/**
 * The only representation of the config that may be logged. The private key
 * is reduced to a presence flag; the RPC URL to its origin.
 */
export function describeConfig(c: KeeperConfig): Record<string, unknown> {
  return {
    rpcUrl: redactString(c.rpcUrl),
    chainId: c.chainId,
    mode: c.keeperPrivateKey ? "keeper" : "observe-only",
    factoryAddress: c.factoryAddress,
    routerAddress: c.routerAddress ?? null,
    bandToleranceBps: c.bandToleranceBps,
    txDeadlineS: c.txDeadlineS,
    storePath: c.storePath,
    healthPollMs: c.healthPollMs,
    rpcDeadlineMs: c.rpcDeadlineMs,
    concurrency: c.concurrency,
    discoveryFromBlock: c.discoveryFromBlock.toString(),
    discoveryChunkBlocks: c.discoveryChunkBlocks,
    watchdogStallMs: c.watchdogStallMs,
    backoffMaxMs: c.backoffMaxMs,
    priceMaxAgeS: c.priceMaxAgeS,
    oracleDeviationBps: c.oracleDeviationBps,
    hfToleranceBps: c.hfToleranceBps,
    logLevel: c.logLevel,
  };
}
