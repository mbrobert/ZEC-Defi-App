/**
 * Solana keeper configuration — the twin of `../config.ts`. Same rules: every variable is validated by name,
 * secrets are never echoed, and the absence of a keeper key means observe-only (valuation and the ladder run,
 * every on-chain action is REFUSED and recorded).
 *
 * The keeper key is a PATH to a Solana keypair JSON (the CLI's format); this module records only that a path
 * was given — the dispatcher reads the file when it signs, never a config dump. Never point it at
 * ~/.config/solana/id.json on a machine where that key holds anything real.
 */
import { isAbsolute } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { CCTP_IRIS, SOLANA_CLUSTER } from "@zyo/shared";
import { ConfigError, readRaw } from "../config.js";

export interface SolanaKeeperConfig {
  rpcUrl: string;
  programId: PublicKey;
  storePath: string;
  /** Absent ⇒ observe-only. */
  keeperKeypairPath?: string;
  /** Fee payer for read-only simulations when there is no keeper key (any funded pubkey). */
  simPayer: PublicKey;
  /** "jupiter" reads an independent ZEC/USDC quote; "scope-only" trusts Kamino's oracle alone — localnet only. */
  priceSource: "jupiter" | "scope-only";
  jupiterQuoteUrl: string;
  priceMaxAgeS: number;
  independentMaxAgeS: number;
  oracleDeviationBps: number;
  hfToleranceBps: number;
  healthPollMs: number;
  rpcDeadlineMs: number;
  dispatchDeadlineMs: number;
  /** Per-channel notifier deadline (NOTIFY_DEADLINE_MS) — the same knob as the Base keeper. */
  notifyDeadlineMs: number;
  watchdogStallMs: number;
  /** Discount off the Scope price the keeper pays on a sale, bps (0 = fair value). */
  saleDiscountBps: number;
  /** The most USDC the keeper will pay in for one sale (base units). 0 ⇒ the keeper never sells. */
  keeperMaxSaleUsdc: bigint;
  /** Margin above a rung's disarm level the plan aims for, bps. */
  planMarginBps: number;
  unknownEscalationStreak: number;
  maxDispatchAttempts: number;
  notifyWebhookUrl?: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /**
   * The Base side of a cross-chain pair (D6 / A5.2): a Base RPC and the router whose `solanaRecipient` says
   * whether a Base account names this Solana Account back. Both or neither; absent = pairs are never read.
   */
  baseRpcUrl?: string;
  baseRouterAddress?: `0x${string}`;
  /** How long a Base burn may be in flight before the single-chain path takes a rung over (s). */
  bridgeStallS: number;
  /** Circle's attestation service: mainnet by default, the sandbox on devnet ↔ Sepolia. */
  attestationBaseUrl: string;
  /** The address lookup table a CCTP delivery rides (created at deploy); absent = deliveries are refused by name. */
  cctpLookupTable?: PublicKey;
}

export const SOLANA_CONFIG_DEFAULTS = {
  priceSource: "jupiter" as const,
  jupiterQuoteUrl: "https://lite-api.jup.ag/swap/v1/quote",
  priceMaxAgeS: 180,
  independentMaxAgeS: 120,
  oracleDeviationBps: 200,
  hfToleranceBps: 100,
  healthPollMs: 30_000,
  rpcDeadlineMs: 15_000,
  dispatchDeadlineMs: 60_000,
  notifyDeadlineMs: 10_000,
  watchdogStallMs: 90_000,
  saleDiscountBps: 0,
  keeperMaxSaleUsdc: 0n,
  planMarginBps: 50,
  unknownEscalationStreak: 3,
  maxDispatchAttempts: 5,
  logLevel: "info" as const,
  bridgeStallS: 1800,
  attestationBaseUrl: CCTP_IRIS.mainnet,
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

function pubkey(env: NodeJS.ProcessEnv, name: string): PublicKey | undefined {
  const raw = readRaw(env, name);
  if (raw === undefined) return undefined;
  try {
    return new PublicKey(raw);
  } catch {
    throw new ConfigError(name, "is not a base58 public key");
  }
}

export function loadSolanaConfig(env: NodeJS.ProcessEnv = process.env): SolanaKeeperConfig {
  const rpcUrl = readRaw(env, "SOLANA_RPC_URL") ?? SOLANA_CLUSTER.rpcDefault;
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new ConfigError("SOLANA_RPC_URL", "is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ConfigError("SOLANA_RPC_URL", "must be http(s)");

  const programId = pubkey(env, "OILSKIN_SOLANA_PROGRAM_ID");
  if (!programId) throw new ConfigError("OILSKIN_SOLANA_PROGRAM_ID", "is required (the deployed oilskin program)");

  const storePath = readRaw(env, "SOLANA_STORE_PATH");
  if (storePath === undefined) throw new ConfigError("SOLANA_STORE_PATH", "is required");
  if (!isAbsolute(storePath)) throw new ConfigError("SOLANA_STORE_PATH", `must be absolute, got ${storePath}`);
  if (/\s/.test(storePath)) throw new ConfigError("SOLANA_STORE_PATH", "must not contain whitespace");

  const keeperKeypairPath = readRaw(env, "KEEPER_SOLANA_KEYPAIR");
  if (keeperKeypairPath !== undefined) {
    if (!isAbsolute(keeperKeypairPath)) throw new ConfigError("KEEPER_SOLANA_KEYPAIR", "must be an absolute path to a keypair JSON file");
    if (/\.config\/solana\/id\.json$/.test(keeperKeypairPath)) {
      throw new ConfigError("KEEPER_SOLANA_KEYPAIR", "must not be the CLI's default keypair — give the keeper its own key");
    }
  }
  const simPayerEnv = pubkey(env, "SOLANA_SIM_PAYER");
  if (!keeperKeypairPath && !simPayerEnv) {
    throw new ConfigError("SOLANA_SIM_PAYER", "is required in observe-only mode (a funded pubkey the read-only simulations name as fee payer; nothing is signed)");
  }

  const priceSourceRaw = readRaw(env, "SOLANA_PRICE_SOURCE") ?? SOLANA_CONFIG_DEFAULTS.priceSource;
  if (priceSourceRaw !== "jupiter" && priceSourceRaw !== "scope-only") throw new ConfigError("SOLANA_PRICE_SOURCE", 'must be "jupiter" or "scope-only"');

  const rpcDeadlineMs = num(env, "RPC_DEADLINE_MS", SOLANA_CONFIG_DEFAULTS.rpcDeadlineMs, { min: 1, integer: true });
  const watchdogStallMs = num(env, "WATCHDOG_STALL_MS", SOLANA_CONFIG_DEFAULTS.watchdogStallMs, { min: 1, integer: true });
  if (watchdogStallMs <= rpcDeadlineMs) throw new ConfigError("WATCHDOG_STALL_MS", `must exceed RPC_DEADLINE_MS (${rpcDeadlineMs})`);
  const dispatchDeadlineMs = num(env, "DISPATCH_DEADLINE_MS", SOLANA_CONFIG_DEFAULTS.dispatchDeadlineMs, { min: 1, integer: true });
  if (dispatchDeadlineMs < rpcDeadlineMs) throw new ConfigError("DISPATCH_DEADLINE_MS", `must be ≥ RPC_DEADLINE_MS (${rpcDeadlineMs})`);

  const maxSaleRaw = readRaw(env, "KEEPER_MAX_SALE_USDC");
  let keeperMaxSaleUsdc: bigint = SOLANA_CONFIG_DEFAULTS.keeperMaxSaleUsdc;
  if (maxSaleRaw !== undefined) {
    if (!/^\d+$/.test(maxSaleRaw)) throw new ConfigError("KEEPER_MAX_SALE_USDC", "must be a non-negative integer of USDC base units");
    keeperMaxSaleUsdc = BigInt(maxSaleRaw);
  }

  const logLevelRaw = readRaw(env, "LOG_LEVEL") ?? SOLANA_CONFIG_DEFAULTS.logLevel;
  if (!["debug", "info", "warn", "error"].includes(logLevelRaw)) throw new ConfigError("LOG_LEVEL", "must be debug|info|warn|error");

  const notifyWebhookUrl = readRaw(env, "NOTIFY_WEBHOOK_URL");

  const attestationUrl = readRaw(env, "CCTP_ATTESTATION_URL") ?? SOLANA_CONFIG_DEFAULTS.attestationBaseUrl;
  try {
    const u = new URL(attestationUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not http(s)");
  } catch {
    throw new ConfigError("CCTP_ATTESTATION_URL", "must be an http(s) URL (Circle's attestation service)");
  }

  const baseRpcUrl = readRaw(env, "BASE_RPC_URL");
  const baseRouterRaw = readRaw(env, "BASE_ROUTER_ADDRESS");
  if ((baseRpcUrl === undefined) !== (baseRouterRaw === undefined)) throw new ConfigError("BASE_ROUTER_ADDRESS", "and BASE_RPC_URL come together (the Base side of a cross-chain pair) or not at all");
  if (baseRpcUrl !== undefined) {
    let u: URL;
    try {
      u = new URL(baseRpcUrl);
    } catch {
      throw new ConfigError("BASE_RPC_URL", "is not a valid URL");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new ConfigError("BASE_RPC_URL", "must be http(s)");
  }
  if (baseRouterRaw !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(baseRouterRaw)) throw new ConfigError("BASE_ROUTER_ADDRESS", "is not an EVM address");

  return {
    rpcUrl,
    programId,
    storePath,
    keeperKeypairPath,
    simPayer: simPayerEnv ?? PublicKey.default,
    priceSource: priceSourceRaw,
    jupiterQuoteUrl: readRaw(env, "SOLANA_JUPITER_QUOTE_URL") ?? SOLANA_CONFIG_DEFAULTS.jupiterQuoteUrl,
    priceMaxAgeS: num(env, "SOLANA_PRICE_MAX_AGE_S", SOLANA_CONFIG_DEFAULTS.priceMaxAgeS, { min: 1, integer: true }),
    independentMaxAgeS: num(env, "SOLANA_INDEPENDENT_MAX_AGE_S", SOLANA_CONFIG_DEFAULTS.independentMaxAgeS, { min: 1, integer: true }),
    oracleDeviationBps: num(env, "SOLANA_ORACLE_DEVIATION_BPS", SOLANA_CONFIG_DEFAULTS.oracleDeviationBps, { min: 1, max: 5000, integer: true }),
    hfToleranceBps: num(env, "SOLANA_HF_TOLERANCE_BPS", SOLANA_CONFIG_DEFAULTS.hfToleranceBps, { min: 1, max: 5000, integer: true }),
    healthPollMs: num(env, "HEALTH_POLL_MS", SOLANA_CONFIG_DEFAULTS.healthPollMs, { min: 1, integer: true }),
    rpcDeadlineMs,
    dispatchDeadlineMs,
    notifyDeadlineMs: num(env, "NOTIFY_DEADLINE_MS", SOLANA_CONFIG_DEFAULTS.notifyDeadlineMs, { min: 1, integer: true }),
    watchdogStallMs,
    saleDiscountBps: num(env, "KEEPER_SALE_DISCOUNT_BPS", SOLANA_CONFIG_DEFAULTS.saleDiscountBps, { min: 0, max: 500, integer: true }),
    keeperMaxSaleUsdc,
    planMarginBps: num(env, "KEEPER_PLAN_MARGIN_BPS", SOLANA_CONFIG_DEFAULTS.planMarginBps, { min: 0, max: 2000, integer: true }),
    unknownEscalationStreak: num(env, "UNKNOWN_ESCALATION_STREAK", SOLANA_CONFIG_DEFAULTS.unknownEscalationStreak, { min: 1, integer: true }),
    maxDispatchAttempts: num(env, "MAX_DISPATCH_ATTEMPTS", SOLANA_CONFIG_DEFAULTS.maxDispatchAttempts, { min: 1, integer: true }),
    notifyWebhookUrl,
    logLevel: logLevelRaw as SolanaKeeperConfig["logLevel"],
    baseRpcUrl,
    baseRouterAddress: baseRouterRaw as `0x${string}` | undefined,
    bridgeStallS: num(env, "BRIDGE_STALL_S", SOLANA_CONFIG_DEFAULTS.bridgeStallS, { min: 60, integer: true }),
    attestationBaseUrl: attestationUrl,
    cctpLookupTable: pubkey(env, "CCTP_LOOKUP_TABLE"),
  };
}

/** Redacted, loggable description. Never includes the keypair path's contents, only whether one was given. */
export function describeSolanaConfig(c: SolanaKeeperConfig): Record<string, unknown> {
  return {
    chain: "solana",
    rpc: c.rpcUrl,
    program: c.programId.toBase58(),
    mode: c.keeperKeypairPath ? "keeper" : "observe-only",
    priceSource: c.priceSource,
    priceMaxAgeS: c.priceMaxAgeS,
    oracleDeviationBps: c.oracleDeviationBps,
    keeperMaxSaleUsdc: c.keeperMaxSaleUsdc.toString(),
    saleDiscountBps: c.saleDiscountBps,
    healthPollMs: c.healthPollMs,
    store: c.storePath,
    basePair: c.baseRpcUrl ? { router: c.baseRouterAddress, bridgeStallS: c.bridgeStallS } : "not read (no BASE_RPC_URL)",
    attestation: c.attestationBaseUrl,
    cctpLookupTable: c.cctpLookupTable?.toBase58() ?? "none (deliveries refused by name)",
  };
}
