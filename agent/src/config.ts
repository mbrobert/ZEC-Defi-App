import { ONE_CLICK_BASE_URL, REWARD_CLAIM_POLICY, RHEA } from "@zyo/shared";

/**
 * Env-driven agent configuration. Hand-rolled validation keeps the agent
 * zero-dependency; every failure names the offending variable.
 */
export interface AgentConfig {
  baseRpcUrl: string;
  operatorPrivateKey?: string;
  positionVault?: string;
  rewardRouter?: string;
  oneClickBaseUrl: string;
  oneClickJwt?: string;
  nearNetworkId: "mainnet" | "testnet";
  rheaMode: "sdk" | "mock";
  healthPollMs: number;
  lpPollMs: number;
  rewardPollMs: number;
  minCostMultiple: number;
  minAbsoluteUsd: number;
  maxHoldDays: number;
  hfWarning: number;
  hfCritical: number;
  hfEmergency: number;
  storePath: string;
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

function oneOf<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  values: readonly T[],
  fallback: T
): T {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!values.includes(raw as T)) {
    throw new ConfigError(name, `must be one of ${values.join(", ")}`);
  }
  return raw as T;
}

function matches(
  env: NodeJS.ProcessEnv,
  name: string,
  pattern: RegExp,
  what: string
): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  if (!pattern.test(raw)) throw new ConfigError(name, `must be ${what}`);
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const hfWarning = num(env, "HF_WARNING", RHEA.healthFactor.warning);
  const hfCritical = num(env, "HF_CRITICAL", RHEA.healthFactor.critical);
  const hfEmergency = num(env, "HF_EMERGENCY", 1.05);
  // The protection ladder only works when the rungs are ordered. Accepting
  // e.g. HF_CRITICAL=1.5 > HF_WARNING=1.2 silently makes EMERGENCY_UNWIND
  // unreachable; negative thresholds make everything HEALTHY. Fail fast.
  if (!(hfWarning > hfCritical && hfCritical > hfEmergency && hfEmergency >= 1)) {
    throw new ConfigError(
      "HF_WARNING/HF_CRITICAL/HF_EMERGENCY",
      `must satisfy warning > critical > emergency ≥ 1 ` +
        `(got warning=${hfWarning}, critical=${hfCritical}, emergency=${hfEmergency})`
    );
  }
  return {
    baseRpcUrl: env.BASE_RPC_URL || "https://mainnet.base.org",
    operatorPrivateKey: matches(
      env,
      "OPERATOR_PRIVATE_KEY",
      /^0x[0-9a-fA-F]{64}$/,
      "a 0x-prefixed 32-byte hex key"
    ),
    positionVault: matches(
      env,
      "POSITION_VAULT_ADDRESS",
      /^0x[0-9a-fA-F]{40}$/,
      "a 0x-prefixed address"
    ),
    rewardRouter: matches(
      env,
      "REWARD_ROUTER_ADDRESS",
      /^0x[0-9a-fA-F]{40}$/,
      "a 0x-prefixed address"
    ),
    oneClickBaseUrl: env.ONE_CLICK_BASE_URL || ONE_CLICK_BASE_URL,
    oneClickJwt: env.ONE_CLICK_JWT || undefined,
    nearNetworkId: oneOf(env, "NEAR_NETWORK_ID", ["mainnet", "testnet"] as const, "mainnet"),
    rheaMode: oneOf(env, "RHEA_MODE", ["sdk", "mock"] as const, "mock"),
    healthPollMs: num(env, "HEALTH_POLL_MS", 60_000, 5_000),
    lpPollMs: num(env, "LP_POLL_MS", 120_000, 5_000),
    rewardPollMs: num(env, "REWARD_POLL_MS", 300_000, 10_000),
    minCostMultiple: num(env, "MIN_COST_MULTIPLE", REWARD_CLAIM_POLICY.minCostMultiple, 1),
    minAbsoluteUsd: num(env, "MIN_ABSOLUTE_USD", REWARD_CLAIM_POLICY.minAbsoluteUsd, 0),
    maxHoldDays: num(env, "MAX_HOLD_DAYS", REWARD_CLAIM_POLICY.maxHoldDays, 1),
    hfWarning,
    hfCritical,
    hfEmergency,
    storePath: env.STORE_PATH || "data/strategies.json",
  };
}
