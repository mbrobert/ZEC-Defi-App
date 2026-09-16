/**
 * Env-driven configuration. Zero dependencies; every failure names the
 * offending variable. Secrets are referenced by env NAME only and never
 * logged.
 *
 * External addresses are NOT configurable: every one comes from
 * @zyo/shared (docs/VERIFIED-BASE-FACTS.md). The only chain knobs are the
 * RPC endpoint and the engine vault the backfill indexes.
 */

import { existsSync, readFileSync } from "node:fs";

export interface YieldConfig {
  /** Base JSON-RPC endpoint (full URL incl. any provider key). */
  baseRpcUrl?: string;
  /** Blockscout PRO API key (Bearer). Optional — RPC-only mode works. */
  blockscoutKey?: string;
  /** Snuggle engine vault proxy on Base (backfill/indexer only). */
  engineVault: string;
  /**
   * Oilskin's `CollateralRegistry` on Base (`COLLATERAL_REGISTRY_ADDRESS`), lower-cased. When set and an
   * RPC is configured, `/v1/forecast` refuses `entry_hf_below_floor` against the floor read from it
   * (`entryHfFloorWad`, BUILD-PLAN-2026-09-12 D7); unset — nothing is deployed yet — the shared constant
   * is served and the payload says so (`entryHfFloorSource: "shared"`).
   */
  collateralRegistry?: string;
  /**
   * A Solana JSON-RPC endpoint (`SOLANA_RPC_URL`). When set, the server samples Kamino's ZCASH market
   * (`sources/kamino.ts`) on the refresh cadence and serves `/v1/solana/borrow` (SOLANA-ARCHITECTURE.md §7);
   * unset, that route answers `kamino_unavailable` and says the source is not configured.
   */
  solanaRpcUrl?: string;
  port: number;
  /** Where backfill JSONL + state live. */
  dataDir: string;
  /** Where recorded samples (volatility inputs, gauge samples) live. */
  samplesDir: string;
  /** Live-sample refresh cadence. */
  refreshMs: number;
  /**
   * Door 1 — sending a user's USDC out as ZEC (`docs/ZEC-FORMS-AND-DOORS-2026-09-15.md` §3).
   * OFF by default and, on its own, not enough: `/v1/exit-quote` also requires
   * `docs/VERIFIED-ZEC-ROUTES-<date>.md` to exist, which no flag can substitute for. This is the
   * operator's switch; the facts file is the precondition.
   */
  zecExitEnabled: boolean;
  /**
   * Samples older than this are STALE: served with stale:true and never
   * used by the gate (fail closed).
   */
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
 * 2026-08-06, the fork suite, and the 2026-09-03 log sweep all run against
 * this address.
 */
export const ENGINE_VAULT_DEFAULT = "0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55";

/**
 * A path under services/yield whether this file runs compiled (dist/src/config.js) or through
 * tsx (src/config.ts): the old `new URL("../../samples", import.meta.url)` was right for dist/
 * and wrong for `npm run backfill` (tsx), which resolved to services/samples — the live sample of
 * 2026-09-12 (slice K) read every gauge and then failed to write. YIELD_*_DIR still overrides.
 */
function packageRelative(dir: string): string {
  const here = new URL(".", import.meta.url).pathname;
  return new URL(here.endsWith("/dist/src/") ? `../../${dir}` : `../${dir}`, import.meta.url).pathname;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): YieldConfig {
  const vault = str(env, "ENGINE_VAULT_ADDRESS", ENGINE_VAULT_DEFAULT).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(vault)) throw new ConfigError("ENGINE_VAULT_ADDRESS", "not an address");
  const registryRaw = opt(env, "COLLATERAL_REGISTRY_ADDRESS");
  const collateralRegistry = registryRaw === undefined ? undefined : registryRaw.toLowerCase();
  if (collateralRegistry !== undefined && !/^0x[0-9a-f]{40}$/.test(collateralRegistry)) {
    throw new ConfigError("COLLATERAL_REGISTRY_ADDRESS", "not an address");
  }
  const solanaRpcUrl = opt(env, "SOLANA_RPC_URL");
  if (solanaRpcUrl !== undefined && !/^https?:\/\//.test(solanaRpcUrl)) throw new ConfigError("SOLANA_RPC_URL", "must be an http(s) URL");
  return {
    baseRpcUrl: opt(env, "BASE_RPC_URL"),
    solanaRpcUrl,
    blockscoutKey: opt(env, "BLOCKSCOUT_PRO_API_KEY"),
    engineVault: vault,
    collateralRegistry,
    port: num(env, "YIELD_PORT", 8787, 1),
    dataDir: str(env, "YIELD_DATA_DIR", packageRelative("data")),
    samplesDir: str(env, "YIELD_SAMPLES_DIR", packageRelative("samples")),
    refreshMs: num(env, "YIELD_REFRESH_MS", 120_000, 5_000),
    // Exactly "1" turns it on. Anything else — unset, "true", "yes", a typo — leaves Door 1 shut,
    // which is the direction a flag guarding an unread route should fail in.
    zecExitEnabled: env.ZEC_EXIT_ENABLED === "1",
    staleAfterMs: num(env, "YIELD_STALE_AFTER_MS", 600_000, 10_000),
    cohortWindows: str(env, "YIELD_COHORT_WINDOWS", "30,60,90")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    minDaysOpen: num(env, "YIELD_MIN_DAYS_OPEN", 1, 0),
    logChunk: num(env, "YIELD_LOG_CHUNK", 5_000, 100),
  };
}

/**
 * Per-pool annualized volatility inputs for the IL-drag model, with
 * provenance. Shape: { pools: { [curatedId]: { sigma, provenance } }, … }.
 * A pool absent from the file has NO σ → the gate refuses it with
 * `no_volatility_input` (never a default).
 */
export interface VolatilityInputs {
  asOf: string;
  method: string;
  pools: Record<string, { sigma: number; provenance: string }>;
}

export function loadVolatility(path: string): VolatilityInputs {
  if (!existsSync(path)) throw new ConfigError("volatility", `file not found: ${path}`);
  const v = JSON.parse(readFileSync(path, "utf8")) as VolatilityInputs;
  if (!v || typeof v !== "object" || typeof v.pools !== "object") {
    throw new ConfigError("volatility", `unexpected shape in ${path}`);
  }
  for (const [id, e] of Object.entries(v.pools)) {
    if (!(typeof e.sigma === "number" && Number.isFinite(e.sigma) && e.sigma > 0 && e.sigma < 5)) {
      throw new ConfigError("volatility", `${id}: sigma must be a finite number in (0, 5)`);
    }
    if (typeof e.provenance !== "string" || !e.provenance) {
      throw new ConfigError("volatility", `${id}: provenance required`);
    }
  }
  return v;
}
