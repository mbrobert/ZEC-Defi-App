/**
 * Perps keeper configuration — the third chain's twin of `../config.ts` and `../solana/config.ts`
 * (BUILD-PLAN Stream D step D4; `docs/PERPS-DESIGN-2026-09-25.md` §5). Same rules: every variable is
 * validated by name, secrets are never echoed, and the absence of a keeper key means observe-only (the
 * valuation and the ladder run, every on-chain action is REFUSED and recorded).
 *
 * The keeper key on HyperEVM is a THIRD key (design §5): where it lives beside the Base and Solana ones is
 * the founder's decision (§10 item 6); this module only validates its shape and never serialises it.
 *
 * No health threshold is configurable here. The ladder derives from the entry each account recorded on
 * the venue (D9) through `packages/shared` `perpLadderFor`; typing a rung in an env var is the bug the
 * hard rules forbid. The two knobs that ARE the keeper's own — how many blocks a CoreWriter action is given
 * to land before it is judged, and the de-risk fraction — are named as such, with their defaults.
 */
import { isAbsolute } from "node:path";
import { HYPERLIQUID } from "@zyo/shared";
import type { Address, Hex } from "../types/evm.js";
import { isAddress } from "../types/evm.js";
import { ConfigError, readRaw } from "../config.js";

export interface PerpsKeeperConfig {
  rpcUrl: string;
  /** 999 (HyperEVM) or 998 (its testnet); anything else is refused at startup. */
  chainId: number;
  /** `HyperliquidPerpVenue` — the keeper's only write target, reached through the account's `execAsKeeper`. */
  venueAddress: Address;
  /** `OilskinAccountFactory` on HyperEVM — the source of `AccountCreated` discovery logs. */
  factoryAddress: Address;
  storePath: string;
  /** Absent ⇒ observe-only. */
  keeperPrivateKey?: Hex;
  /** First block to scan for `AccountCreated` when the store has no cursor (the factory's deployment block). */
  discoveryFromBlock: bigint;
  discoveryChunkBlocks: number;
  /** "api" reads the venue's own `metaAndAssetCtxs` as the independent mark; "precompile-only" trusts the precompile alone — testnet only. */
  priceSource: "api" | "precompile-only";
  infoApiUrl: string;
  independentMaxAgeS: number;
  /** Precompile mark versus the API's mark, bps. The venue's own mark-versus-oracle bound is read from the venue. */
  oracleDeviationBps: number;
  /**
   * Blocks a CoreWriter action is given to land on HyperCore before `confirm` judges it by a read (design
   * §5: "the position moves N blocks after the receipt"). The venue's word is "a few seconds"; the default
   * is the keeper's own margin over that, not a chain fact.
   */
  actionDelayBlocks: number;
  /** The most of the short a de-risk rung may close in one action, bps of the size (design §5: a third). */
  deriskFractionBps: number;
  /** Margin above a rung's disarm level the plan aims for, bps. */
  planMarginBps: number;
  healthPollMs: number;
  rpcDeadlineMs: number;
  dispatchDeadlineMs: number;
  notifyDeadlineMs: number;
  watchdogStallMs: number;
  unknownEscalationStreak: number;
  maxDispatchAttempts: number;
  notifyWebhookUrl?: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export const PERPS_CONFIG_DEFAULTS = {
  chainId: HYPERLIQUID.chainId,
  discoveryChunkBlocks: 2_000,
  priceSource: "api" as const,
  infoApiUrl: HYPERLIQUID.infoApi,
  independentMaxAgeS: 120,
  oracleDeviationBps: 200,
  actionDelayBlocks: 10,
  deriskFractionBps: 3_333,
  planMarginBps: 50,
  healthPollMs: 30_000,
  rpcDeadlineMs: 15_000,
  dispatchDeadlineMs: 60_000,
  notifyDeadlineMs: 10_000,
  watchdogStallMs: 90_000,
  unknownEscalationStreak: 3,
  maxDispatchAttempts: 5,
  logLevel: "info" as const,
} as const;

function num(env: NodeJS.ProcessEnv, name: string, dflt: number, opts: { min?: number; max?: number; integer?: boolean } = {}): number {
  const raw = readRaw(env, name);
  if (raw === undefined) return dflt;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new ConfigError(name, "must be a number");
  if (opts.integer && !Number.isInteger(v)) throw new ConfigError(name, "must be an integer");
  if (opts.min !== undefined && v < opts.min) throw new ConfigError(name, `must be ≥ ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw new ConfigError(name, `must be ≤ ${opts.max}`);
  return v;
}

function address(env: NodeJS.ProcessEnv, name: string): Address | undefined {
  const raw = readRaw(env, name);
  if (raw === undefined) return undefined;
  if (!isAddress(raw)) throw new ConfigError(name, "is not an EVM address");
  return raw.toLowerCase() as Address;
}

function httpUrl(env: NodeJS.ProcessEnv, name: string, dflt?: string): string | undefined {
  const raw = readRaw(env, name) ?? dflt;
  if (raw === undefined) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(name, "is not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ConfigError(name, "must be http(s)");
  return raw;
}

export function loadPerpsConfig(env: NodeJS.ProcessEnv = process.env): PerpsKeeperConfig {
  const rpcUrl = httpUrl(env, "HYPEREVM_RPC_URL");
  if (rpcUrl === undefined) throw new ConfigError("HYPEREVM_RPC_URL", "is required (HyperEVM's JSON-RPC)");

  const chainId = num(env, "HYPEREVM_CHAIN_ID", PERPS_CONFIG_DEFAULTS.chainId, { integer: true, min: 1 });
  if (chainId !== HYPERLIQUID.chainId && chainId !== HYPERLIQUID.testnet.chainId) {
    throw new ConfigError("HYPEREVM_CHAIN_ID", `must be ${HYPERLIQUID.chainId} (HyperEVM) or ${HYPERLIQUID.testnet.chainId} (its testnet)`);
  }

  const venueAddress = address(env, "PERPS_VENUE_ADDRESS");
  if (!venueAddress) throw new ConfigError("PERPS_VENUE_ADDRESS", "is required (the deployed HyperliquidPerpVenue)");
  const factoryAddress = address(env, "PERPS_FACTORY_ADDRESS");
  if (!factoryAddress) throw new ConfigError("PERPS_FACTORY_ADDRESS", "is required (the OilskinAccountFactory on HyperEVM)");

  const storePath = readRaw(env, "PERPS_STORE_PATH");
  if (storePath === undefined) throw new ConfigError("PERPS_STORE_PATH", "is required");
  if (!isAbsolute(storePath)) throw new ConfigError("PERPS_STORE_PATH", `must be absolute, got ${storePath}`);
  if (/\s/.test(storePath)) throw new ConfigError("PERPS_STORE_PATH", "must not contain whitespace");

  const keyRaw = readRaw(env, "KEEPER_PERPS_PRIVATE_KEY");
  let keeperPrivateKey: Hex | undefined;
  if (keyRaw !== undefined) {
    // Do not echo the value — even a malformed key is somebody's secret.
    if (!/^0x[0-9a-fA-F]{64}$/.test(keyRaw)) throw new ConfigError("KEEPER_PERPS_PRIVATE_KEY", "must be a 0x-prefixed 32-byte hex key");
    if (/^0x0{64}$/.test(keyRaw)) throw new ConfigError("KEEPER_PERPS_PRIVATE_KEY", "must not be zero");
    keeperPrivateKey = keyRaw as Hex;
  }

  const fromRaw = readRaw(env, "PERPS_DISCOVERY_FROM_BLOCK");
  if (fromRaw === undefined) throw new ConfigError("PERPS_DISCOVERY_FROM_BLOCK", "is required (the factory's deployment block on HyperEVM)");
  if (!/^\d+$/.test(fromRaw)) throw new ConfigError("PERPS_DISCOVERY_FROM_BLOCK", "must be a non-negative integer block number");

  const priceSourceRaw = readRaw(env, "PERPS_PRICE_SOURCE") ?? PERPS_CONFIG_DEFAULTS.priceSource;
  if (priceSourceRaw !== "api" && priceSourceRaw !== "precompile-only") throw new ConfigError("PERPS_PRICE_SOURCE", 'must be "api" or "precompile-only"');

  const rpcDeadlineMs = num(env, "RPC_DEADLINE_MS", PERPS_CONFIG_DEFAULTS.rpcDeadlineMs, { min: 1, integer: true });
  const watchdogStallMs = num(env, "WATCHDOG_STALL_MS", PERPS_CONFIG_DEFAULTS.watchdogStallMs, { min: 1, integer: true });
  if (watchdogStallMs <= rpcDeadlineMs) throw new ConfigError("WATCHDOG_STALL_MS", `must exceed RPC_DEADLINE_MS (${rpcDeadlineMs})`);
  const dispatchDeadlineMs = num(env, "DISPATCH_DEADLINE_MS", PERPS_CONFIG_DEFAULTS.dispatchDeadlineMs, { min: 1, integer: true });
  if (dispatchDeadlineMs < rpcDeadlineMs) throw new ConfigError("DISPATCH_DEADLINE_MS", `must be ≥ RPC_DEADLINE_MS (${rpcDeadlineMs})`);

  const logLevelRaw = readRaw(env, "LOG_LEVEL") ?? PERPS_CONFIG_DEFAULTS.logLevel;
  if (!["debug", "info", "warn", "error"].includes(logLevelRaw)) throw new ConfigError("LOG_LEVEL", "must be debug|info|warn|error");

  return {
    rpcUrl,
    chainId,
    venueAddress,
    factoryAddress,
    storePath,
    keeperPrivateKey,
    discoveryFromBlock: BigInt(fromRaw),
    discoveryChunkBlocks: num(env, "PERPS_DISCOVERY_CHUNK_BLOCKS", PERPS_CONFIG_DEFAULTS.discoveryChunkBlocks, { min: 1, integer: true }),
    priceSource: priceSourceRaw,
    infoApiUrl: httpUrl(env, "PERPS_INFO_API_URL", PERPS_CONFIG_DEFAULTS.infoApiUrl)!,
    independentMaxAgeS: num(env, "PERPS_INDEPENDENT_MAX_AGE_S", PERPS_CONFIG_DEFAULTS.independentMaxAgeS, { min: 1, integer: true }),
    oracleDeviationBps: num(env, "PERPS_ORACLE_DEVIATION_BPS", PERPS_CONFIG_DEFAULTS.oracleDeviationBps, { min: 1, max: 5000, integer: true }),
    actionDelayBlocks: num(env, "PERPS_ACTION_DELAY_BLOCKS", PERPS_CONFIG_DEFAULTS.actionDelayBlocks, { min: 1, max: 10_000, integer: true }),
    deriskFractionBps: num(env, "PERPS_DERISK_FRACTION_BPS", PERPS_CONFIG_DEFAULTS.deriskFractionBps, { min: 1, max: 10_000, integer: true }),
    planMarginBps: num(env, "KEEPER_PLAN_MARGIN_BPS", PERPS_CONFIG_DEFAULTS.planMarginBps, { min: 0, max: 2000, integer: true }),
    healthPollMs: num(env, "HEALTH_POLL_MS", PERPS_CONFIG_DEFAULTS.healthPollMs, { min: 1, integer: true }),
    rpcDeadlineMs,
    dispatchDeadlineMs,
    notifyDeadlineMs: num(env, "NOTIFY_DEADLINE_MS", PERPS_CONFIG_DEFAULTS.notifyDeadlineMs, { min: 1, integer: true }),
    watchdogStallMs,
    unknownEscalationStreak: num(env, "UNKNOWN_ESCALATION_STREAK", PERPS_CONFIG_DEFAULTS.unknownEscalationStreak, { min: 1, integer: true }),
    maxDispatchAttempts: num(env, "MAX_DISPATCH_ATTEMPTS", PERPS_CONFIG_DEFAULTS.maxDispatchAttempts, { min: 1, integer: true }),
    notifyWebhookUrl: readRaw(env, "NOTIFY_WEBHOOK_URL"),
    logLevel: logLevelRaw as PerpsKeeperConfig["logLevel"],
  };
}

/** Redacted, loggable description. Never includes the key, only whether one was given. */
export function describePerpsConfig(c: PerpsKeeperConfig): Record<string, unknown> {
  let rpc = c.rpcUrl;
  try {
    rpc = new URL(c.rpcUrl).origin;
  } catch {
    /* validated above */
  }
  return {
    chain: c.chainId === HYPERLIQUID.chainId ? "hyperevm" : "hyperevm-testnet",
    chainId: c.chainId,
    rpc,
    venue: c.venueAddress,
    factory: c.factoryAddress,
    mode: c.keeperPrivateKey ? "keeper" : "observe-only",
    priceSource: c.priceSource,
    oracleDeviationBps: c.oracleDeviationBps,
    independentMaxAgeS: c.independentMaxAgeS,
    actionDelayBlocks: c.actionDelayBlocks,
    deriskFractionBps: c.deriskFractionBps,
    planMarginBps: c.planMarginBps,
    healthPollMs: c.healthPollMs,
    discoveryFromBlock: c.discoveryFromBlock.toString(),
    store: c.storePath,
  };
}
