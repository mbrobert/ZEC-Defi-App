/**
 * Env-driven configuration, mirroring agent/src/config.ts conventions.
 * Zero dependencies; every failure names the offending variable. Secrets are
 * referenced by env NAME only and never logged.
 */

export interface YieldConfig {
  /** Base JSON-RPC endpoint (full URL incl. any provider key). */
  baseRpcUrl?: string;
  /** Blockscout PRO API key (Bearer). Optional — RPC-only mode works. */
  blockscoutKey?: string;
  /** NEAR JSON-RPC endpoint for Rhea/Burrow view calls. */
  nearRpcUrl: string;
  /** Rhea lending contract account id on NEAR. */
  rheaLendingContract: string;
  /** NEP-141 token id whose borrow/supply rates we serve (USDC). */
  rheaUsdcTokenId: string;
  /** NEP-141 token id for ZEC (collateral-side supply APR). */
  rheaZecTokenId: string;
  /** Snuggle engine vault proxy on Base. */
  engineVault: string;
  port: number;
  /** Where backfill JSONL + state live. */
  dataDir: string;
  /** Live-sample refresh cadence. */
  refreshMs: number;
  /** Payloads older than this are flagged stale (still served). */
  staleAfterMs: number;
  /** Cohort windows (days). */
  cohortWindows: number[];
  /** Positions open less than this many days are excluded from bands. */
  minDaysOpen: number;
  /** getLogs chunk size (blocks); auto-halved on range errors. */
  logChunk: number;
}

class ConfigError extends Error {
  constructor(name: string, detail: string) {
    super(`config ${name}: ${detail}`);
    this.name = "ConfigError";
  }
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min?: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new ConfigError(name, `not a number: ${raw}`);
  if (min !== undefined && v < min) throw new ConfigError(name, `must be ≥ ${min}`);
  return v;
}

function str(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function opt(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * Engine vault proxy — verified: our on-chain registry enumeration
 * 2026-08-06 and the fork suite both run against this address.
 */
export const ENGINE_VAULT_DEFAULT = "0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55";

/**
 * Rhea lending = the Burrow contract (docs/RHEA-SDK.md: the SDK exports
 * BURROW_CONTRACT_ID). Default set to the mainnet Burrow account and
 * verified with a live get_asset view call (see docs/YIELD-SERVICE.md,
 * verification log 2026-08-27); override with RHEA_LENDING_CONTRACT.
 */
export const RHEA_LENDING_DEFAULT = "contract.main.burrow.near";

/** Native USDC on NEAR (nep141), the borrow asset our strategy uses. */
export const RHEA_USDC_DEFAULT =
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/** Bridged ZEC on NEAR — get_asset verified live 2026-08-27. */
export const RHEA_ZEC_DEFAULT = "zec.omft.near";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): YieldConfig {
  return {
    baseRpcUrl: opt(env, "BASE_RPC_URL"),
    blockscoutKey: opt(env, "BLOCKSCOUT_PRO_API_KEY"),
    nearRpcUrl: str(env, "NEAR_RPC_URL", "https://rpc.mainnet.near.org"),
    rheaLendingContract: str(env, "RHEA_LENDING_CONTRACT", RHEA_LENDING_DEFAULT),
    rheaUsdcTokenId: str(env, "RHEA_USDC_TOKEN_ID", RHEA_USDC_DEFAULT),
    rheaZecTokenId: str(env, "RHEA_ZEC_TOKEN_ID", RHEA_ZEC_DEFAULT),
    engineVault: str(env, "ENGINE_VAULT_ADDRESS", ENGINE_VAULT_DEFAULT).toLowerCase(),
    port: num(env, "YIELD_PORT", 8787, 1),
    dataDir: str(env, "YIELD_DATA_DIR", new URL("../../data", import.meta.url).pathname),
    refreshMs: num(env, "YIELD_REFRESH_MS", 120_000, 5_000),
    staleAfterMs: num(env, "YIELD_STALE_AFTER_MS", 600_000, 10_000),
    cohortWindows: str(env, "YIELD_COHORT_WINDOWS", "30,60,90")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    minDaysOpen: num(env, "YIELD_MIN_DAYS_OPEN", 1, 0),
    logChunk: num(env, "YIELD_LOG_CHUNK", 5_000, 100),
  };
}
