import { isAbsolute } from "node:path";
import type { Address, Hex } from "./types/evm.js";
import { isAddress } from "./types/evm.js";
import { redactString } from "./log.js";
import { MissingChainAddressError, PinnedChainAddressError, SUPPORTED_CHAIN_IDS, chainTable, isSupportedChainId, resolveTokens, type ChainTable, type TokenInfo, type TokenSymbol } from "@zyo/shared";

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
  /**
   * The address table for `chainId` (packages/shared `CHAINS`): Aave, feeds, Pyth, Permit2. Base
   * mainnet is the product; Base Sepolia the rehearsal. A chain without a table is refused by name
   * (slice 6, 2026-09-10; audit wave 2 S-MED-1).
   */
  chain: ChainTable;
  /**
   * Every token by role, resolved for `chainId`: the pinned ones from the table, the deploy-time
   * doubles (Sepolia's cbZEC / AERO) from CBZEC_ADDRESS / AERO_ADDRESS — refused by name when
   * missing, and refused when set for a token the table pins.
   */
  tokens: Readonly<Record<TokenSymbol, TokenInfo>>;
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
  /**
   * FALLBACK Chainlink staleness bound. The bound actually enforced is PER
   * FEED, measured at startup from each aggregator's own round cadence
   * (engine/feeds.ts) and floored by this value. One global constant was wrong
   * for every feed at once: 10,800 s against a live USDC/USD round 44,475 s
   * old made every borrower UNKNOWN on every tick (audit C-HIGH-2).
   */
  priceMaxAgeS: number;
  /** Per-reserve operator overrides, from PRICE_MAX_AGE_S_<SYMBOL>. */
  priceMaxAgeOverridesS: Record<string, number>;
  /** Multiplier on a feed's largest observed inter-round gap. */
  feedHeartbeatSlack: number;
  /** Floor under a probed staleness bound (a fast feed must not get a hair trigger). */
  feedMinMaxAgeS: number;
  /** Historical rounds walked back per feed when measuring that gap. */
  feedHeartbeatRounds: number;
  /**
   * What to do when the resolved policy would make EVERY account UNKNOWN.
   * `fatal` (default) refuses to start; `warn` is an explicit operator override.
   */
  feedSelfCheck: "fatal" | "warn";
  /** Ceiling for the retry-widened LP price band. */
  bandMaxToleranceBps: number;
  /** Slippage tolerance handed to the swap adapter (its on-chain cap is 500). */
  swapMaxSlippageBps: number;
  /** Single-id value probes per dispatch (sizing a rung by value, not id count). */
  maxValueProbes: number;
  /** Warn/escalate when the protection grant expires within this many seconds. */
  grantExpiryWarnS: number;
  /** Unfinished dispatch records resumed per tick. */
  maxResumePerTick: number;
  /** Wall clock for one dispatch (fresh or resumed); beyond it the fleet moves on. */
  dispatchDeadlineMs: number;
  /** Stalls before a wedged dispatch record is quarantined. */
  maxRecordStalls: number;
  /** Times a rung may be re-armed after an action that did not clear it. */
  maxRungRefires: number;
  /** Host-vs-chain clock difference (seconds) worth a warning. */
  clockDriftMaxS: number;
  /** Where rung notifications and escalations are POSTed. Absent ⇒ log only. */
  notifyWebhookUrl?: string;
  notifyWebhookToken?: string;
  notifyDeadlineMs: number;
  /**
   * Run with the keeper's own log and store as the ONLY notification channels. Off by default:
   * without a person-facing channel every warning is written to a host the user cannot see and
   * nothing else, so startup refuses unless an operator says so explicitly (audit wave 2, N-MED-1).
   */
  notifyAllowLogOnly: boolean;
  /** Terminal dispatch records kept per account before pruning. */
  storeKeepTerminalPerAccount: number;
  /** A store lock whose heartbeat is older than this is reclaimable. */
  storeLockStaleMs: number;
  /**
   * Chainlink vs Aave-oracle disagreement beyond this ⇒ UNKNOWN. The same bound governs a
   * non-Aave venue's own health factor against the health factor the keeper's feeds imply from the
   * venue's collateral, debt and threshold (engine/venueValuation.ts V4): the venue's threshold and
   * debt are its own words, so the only thing the two can disagree about is the price its oracle used.
   */
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
  bandMaxToleranceBps: 500,
  swapMaxSlippageBps: 100,
  maxValueProbes: 24,
  grantExpiryWarnS: 7 * 86_400,
  maxResumePerTick: 25,
  dispatchDeadlineMs: 60_000,
  maxRecordStalls: 3,
  maxRungRefires: 2,
  clockDriftMaxS: 120,
  feedHeartbeatSlack: 2,
  feedMinMaxAgeS: 300,
  feedHeartbeatRounds: 6,
  notifyDeadlineMs: 10_000,
  storeKeepTerminalPerAccount: 50,
  storeLockStaleMs: 5 * 60_000,
  txDeadlineS: 180,
} as const;

/** `PRICE_MAX_AGE_S_<SYMBOL>` — a deliberate per-feed override by an operator. */
export function readPriceMaxAgeOverrides(env: NodeJS.ProcessEnv): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(env)) {
    const m = /^PRICE_MAX_AGE_S_([A-Za-z0-9]+)$/.exec(key);
    if (!m) continue;
    out[m[1]] = num(env, key, 0, { min: 1, integer: true });
  }
  return out;
}

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

  const dispatchDeadlineMs = num(env, "DISPATCH_DEADLINE_MS", CONFIG_DEFAULTS.dispatchDeadlineMs, { min: 1, integer: true });
  if (dispatchDeadlineMs < rpcDeadlineMs) {
    // A resume bound shorter than one RPC deadline would quarantine records
    // that are merely waiting on a slow node.
    throw new ConfigError("DISPATCH_DEADLINE_MS", `must be ≥ RPC_DEADLINE_MS (${rpcDeadlineMs})`);
  }

  // Every Aave, token and feed address this keeper reads comes from the packages/shared table for
  // CHAIN_ID — Base mainnet (8453, the product) or Base Sepolia (84532, the rehearsal). A chain
  // without a table is refused by name rather than run against mainnet addresses (audit wave 2,
  // S-MED-1; slice 6, 2026-09-10), and a token the table leaves to a deploy-time double must be
  // named in env, or the keeper refuses by that variable's name — never a silent mainnet address.
  const chainId = num(env, "CHAIN_ID", CONFIG_DEFAULTS.chainId, { min: 1, integer: true });
  if (!isSupportedChainId(chainId)) {
    throw new ConfigError(
      "CHAIN_ID",
      `unsupported chain ${chainId}: packages/shared has address tables for ${SUPPORTED_CHAIN_IDS.join(", ")} only — Base mainnet (8453) is the product, Base Sepolia (84532) the rehearsal; nothing else has verified addresses`
    );
  }
  const chain = chainTable(chainId);
  let tokens: Readonly<Record<TokenSymbol, TokenInfo>>;
  try {
    tokens = resolveTokens(chain, { cbZEC: readRaw(env, "CBZEC_ADDRESS"), AERO: readRaw(env, "AERO_ADDRESS") }, (symbol) => `${symbol.toUpperCase()}_ADDRESS`);
  } catch (e) {
    if (e instanceof MissingChainAddressError || e instanceof PinnedChainAddressError) throw new ConfigError(e.variable, e.message);
    throw new ConfigError("CHAIN_ID", e instanceof Error ? e.message : String(e));
  }

  const notifyWebhookUrl = readRaw(env, "NOTIFY_WEBHOOK_URL");
  if (notifyWebhookUrl !== undefined) {
    let u: URL;
    try {
      u = new URL(notifyWebhookUrl);
    } catch {
      throw new ConfigError("NOTIFY_WEBHOOK_URL", "is not a valid URL");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new ConfigError("NOTIFY_WEBHOOK_URL", "must be http(s)");
  }

  return {
    rpcUrl,
    chainId,
    chain,
    tokens,
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
    priceMaxAgeOverridesS: readPriceMaxAgeOverrides(env),
    feedHeartbeatSlack: num(env, "FEED_HEARTBEAT_SLACK", CONFIG_DEFAULTS.feedHeartbeatSlack, { min: 1, max: 100 }),
    feedMinMaxAgeS: num(env, "FEED_MIN_MAX_AGE_S", CONFIG_DEFAULTS.feedMinMaxAgeS, { min: 1, integer: true }),
    feedHeartbeatRounds: num(env, "FEED_HEARTBEAT_ROUNDS", CONFIG_DEFAULTS.feedHeartbeatRounds, { min: 2, max: 50, integer: true }),
    feedSelfCheck: oneOf(env, "FEED_SELFCHECK", ["fatal", "warn"] as const, "fatal"),
    bandMaxToleranceBps: num(env, "BAND_MAX_TOLERANCE_BPS", CONFIG_DEFAULTS.bandMaxToleranceBps, { min: 1, max: 5_000, integer: true }),
    // The adapter reverts SlippageTooHigh above 500 bps; refuse it here instead.
    swapMaxSlippageBps: num(env, "SWAP_MAX_SLIPPAGE_BPS", CONFIG_DEFAULTS.swapMaxSlippageBps, { min: 1, max: 500, integer: true }),
    maxValueProbes: num(env, "MAX_VALUE_PROBES", CONFIG_DEFAULTS.maxValueProbes, { min: 1, max: 200, integer: true }),
    grantExpiryWarnS: num(env, "GRANT_EXPIRY_WARN_S", CONFIG_DEFAULTS.grantExpiryWarnS, { min: 1, integer: true }),
    maxResumePerTick: num(env, "MAX_RESUME_PER_TICK", CONFIG_DEFAULTS.maxResumePerTick, { min: 1, max: 1_000, integer: true }),
    dispatchDeadlineMs,
    maxRecordStalls: num(env, "MAX_RECORD_STALLS", CONFIG_DEFAULTS.maxRecordStalls, { min: 1, max: 100, integer: true }),
    maxRungRefires: num(env, "MAX_RUNG_REFIRES", CONFIG_DEFAULTS.maxRungRefires, { min: 0, max: 100, integer: true }),
    clockDriftMaxS: num(env, "CLOCK_DRIFT_MAX_S", CONFIG_DEFAULTS.clockDriftMaxS, { min: 1, integer: true }),
    notifyWebhookUrl,
    notifyWebhookToken: readRaw(env, "NOTIFY_WEBHOOK_TOKEN"),
    notifyDeadlineMs: num(env, "NOTIFY_DEADLINE_MS", CONFIG_DEFAULTS.notifyDeadlineMs, { min: 1, integer: true }),
    notifyAllowLogOnly: oneOf(env, "NOTIFY_ALLOW_LOG_ONLY", ["0", "1"] as const, "0") === "1",
    storeKeepTerminalPerAccount: num(env, "STORE_KEEP_TERMINAL_PER_ACCOUNT", CONFIG_DEFAULTS.storeKeepTerminalPerAccount, {
      min: 1,
      max: 100_000,
      integer: true,
    }),
    storeLockStaleMs: num(env, "STORE_LOCK_STALE_MS", CONFIG_DEFAULTS.storeLockStaleMs, { min: 1_000, integer: true }),
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
    chain: c.chain.name,
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
    priceMaxAgeOverridesS: c.priceMaxAgeOverridesS,
    feedHeartbeatSlack: c.feedHeartbeatSlack,
    feedMinMaxAgeS: c.feedMinMaxAgeS,
    feedHeartbeatRounds: c.feedHeartbeatRounds,
    feedSelfCheck: c.feedSelfCheck,
    oracleDeviationBps: c.oracleDeviationBps,
    hfToleranceBps: c.hfToleranceBps,
    bandMaxToleranceBps: c.bandMaxToleranceBps,
    swapMaxSlippageBps: c.swapMaxSlippageBps,
    maxValueProbes: c.maxValueProbes,
    grantExpiryWarnS: c.grantExpiryWarnS,
    maxResumePerTick: c.maxResumePerTick,
    dispatchDeadlineMs: c.dispatchDeadlineMs,
    maxRecordStalls: c.maxRecordStalls,
    maxRungRefires: c.maxRungRefires,
    clockDriftMaxS: c.clockDriftMaxS,
    // The URL is reduced to its origin by the logger's redaction; the token is
    // never serialised at all, only its presence.
    notify: c.notifyWebhookUrl ? { webhook: redactString(c.notifyWebhookUrl), token: c.notifyWebhookToken ? "set" : "unset" } : null,
    notifyAllowLogOnly: c.notifyAllowLogOnly,
    notifyDeadlineMs: c.notifyDeadlineMs,
    storeKeepTerminalPerAccount: c.storeKeepTerminalPerAccount,
    storeLockStaleMs: c.storeLockStaleMs,
    logLevel: c.logLevel,
  };
}
