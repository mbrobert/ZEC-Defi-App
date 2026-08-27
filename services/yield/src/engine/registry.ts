/**
 * Engine pool-registry sync: approvedPools(bytes32) per curated pool →
 * token0/token1 map for flow attribution, cross-checked against the
 * curated list's recorded pool addresses.
 */

import { CURATED_POOLS } from "@zyo/shared";
import { SEL, strip0x, word, wordToAddress } from "../abi.js";
import type { RpcClient } from "../sources/rpc.js";
import type { Address, Hex } from "../types.js";
import type { PoolTokenMap } from "./lifecycles.js";

export interface EnginePoolConfig {
  enginePoolId: Hex;
  curatedId: string;
  pool: Address;
  token0: Address;
  token1: Address;
  /**
   * The registry's raw `fee` word, verbatim. Units differ by DEX (Uniswap
   * ppm vs Aerodrome tick-spacing-keyed pools — verified live: Aero
   * WETH/USDC 0.05% stores 100 here), so display/fee math always uses the
   * curated list's feeTierBps, never this.
   */
  engineFeeRaw: number;
  active: boolean;
}

export async function syncEngineRegistry(
  rpc: RpcClient,
  vault: Address
): Promise<{ pools: EnginePoolConfig[]; tokenMap: PoolTokenMap; mismatches: string[] }> {
  const curated = CURATED_POOLS.filter((p) => p.enginePoolId && p.poolAddress);
  const results = await rpc.callMany<string>(
    curated.map((p) => ({
      method: "eth_call",
      params: [{ to: vault, data: SEL.approvedPools + strip0x(p.enginePoolId!) }, "latest"],
    }))
  );

  const pools: EnginePoolConfig[] = [];
  const tokenMap: PoolTokenMap = new Map();
  const mismatches: string[] = [];

  curated.forEach((p, i) => {
    const raw = strip0x(results[i] ?? "");
    if (raw.length < 8 * 64) {
      mismatches.push(`${p.id}: approvedPools returned ${raw.length / 2} bytes`);
      return;
    }
    const cfg: EnginePoolConfig = {
      enginePoolId: p.enginePoolId!.toLowerCase() as Hex,
      curatedId: p.id,
      pool: wordToAddress(word(raw, 0)),
      token0: wordToAddress(word(raw, 1)),
      token1: wordToAddress(word(raw, 2)),
      engineFeeRaw: Number(BigInt(`0x${word(raw, 3)}`)),
      active: BigInt(`0x${word(raw, 5)}`) === 1n,
    };
    if (cfg.pool !== p.poolAddress!.toLowerCase()) {
      mismatches.push(`${p.id}: engine pool ${cfg.pool} ≠ curated ${p.poolAddress}`);
    }
    pools.push(cfg);
    tokenMap.set(cfg.enginePoolId, { token0: cfg.token0, token1: cfg.token1 });
  });

  return { pools, tokenMap, mismatches };
}
