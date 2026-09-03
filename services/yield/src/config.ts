/**
 * Env-driven configuration, mirroring agent/src/config.ts conventions.
 * Zero dependencies; every failure names the offending variable. Secrets are
 * referenced by env NAME only and never logged.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  /**
   * First block the indexer scans when no state exists yet. Set
   * YIELD_START_BLOCK to skip the eth_getCode creation-block bisection
   * (which needs an archive node — public endpoints often refuse it).
   */
  startBlock?: number;
}

class ConfigError extends Error {
  constructor(name: string, detail: string) {
    super(`config ${name}: ${detail}`);
    this.name = "ConfigError";
  }
}

function num(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min?: number,
  max?: number
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new ConfigError(name, `not a number: ${raw}`);
  if (min !== undefined && v < min) throw new ConfigError(name, `must be ≥ ${min}`);
  if (max !== undefined && v > max) throw new ConfigError(name, `must be ≤ ${max}`);
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

/**
 * The @zyo/yield package root, found by walking up from THIS file to the
 * nearest package.json named "@zyo/yield". Identical whether the code runs
 * from src/ (tsx) or dist/src/ (node) — the old `new URL("../../data", …)`
 * default landed in DIFFERENT directories per entrypoint, so the server
 * never saw backfill output.
 */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const name = (JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name;
        if (name === "@zyo/yield") return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigError("dataDir", "could not locate the @zyo/yield package root");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): YieldConfig {
  const vault = str(env, "ENGINE_VAULT_ADDRESS", ENGINE_VAULT_DEFAULT);
  // The vault address becomes a filename component (events-<vault>.jsonl) and
  // an eth_getLogs filter — a malformed value must never reach either.
  if (!/^0x[0-9a-f]{40}$/i.test(vault)) {
    throw new ConfigError("ENGINE_VAULT_ADDRESS", `not a 0x-prefixed 20-byte address: ${vault}`);
  }

  const rawDataDir = opt(env, "YIELD_DATA_DIR");
  const dataDir =
    rawDataDir === undefined
      ? join(packageRoot(), "data")
      : isAbsolute(rawDataDir)
        ? rawDataDir
        : resolve(process.cwd(), rawDataDir);

  const cohortWindows = str(env, "YIELD_COHORT_WINDOWS", "30,60,90")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!cohortWindows.length) {
    throw new ConfigError(
      "YIELD_COHORT_WINDOWS",
      "no valid windows — expected a comma-separated list of positive day counts (e.g. 30,60,90)"
    );
  }

  const startBlockRaw = opt(env, "YIELD_START_BLOCK");
  let startBlock: number | undefined;
  if (startBlockRaw !== undefined) {
    startBlock = Number(startBlockRaw);
    if (!Number.isInteger(startBlock) || startBlock < 0) {
      throw new ConfigError("YIELD_START_BLOCK", `not a non-negative integer: ${startBlockRaw}`);
    }
  }

  return {
    baseRpcUrl: opt(env, "BASE_RPC_URL"),
    blockscoutKey: opt(env, "BLOCKSCOUT_PRO_API_KEY"),
    nearRpcUrl: str(env, "NEAR_RPC_URL", "https://rpc.mainnet.near.org"),
    rheaLendingContract: str(env, "RHEA_LENDING_CONTRACT", RHEA_LENDING_DEFAULT),
    rheaUsdcTokenId: str(env, "RHEA_USDC_TOKEN_ID", RHEA_USDC_DEFAULT),
    rheaZecTokenId: str(env, "RHEA_ZEC_TOKEN_ID", RHEA_ZEC_DEFAULT),
    engineVault: vault.toLowerCase(),
    port: num(env, "YIELD_PORT", 8787, 1, 65_535),
    dataDir,
    refreshMs: num(env, "YIELD_REFRESH_MS", 120_000, 5_000),
    staleAfterMs: num(env, "YIELD_STALE_AFTER_MS", 600_000, 10_000),
    cohortWindows,
    minDaysOpen: num(env, "YIELD_MIN_DAYS_OPEN", 1, 0),
    logChunk: num(env, "YIELD_LOG_CHUNK", 5_000, 100),
    startBlock,
  };
}
