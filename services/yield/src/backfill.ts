/**
 * Backfill CLI — each subcommand is one resumable pass; run them in order
 * (or just `all`). Progress prints one line per checkpoint; state lives in
 * YIELD_DATA_DIR so a killed run continues where it stopped.
 *
 *   scan        chunked eth_getLogs from the vault's creation block → JSONL
 *   timestamps  fill block timestamps (batched)
 *   receipts    entry-principal pass (Blockscout decoded transfers when a
 *               key is set; raw receipts otherwise)
 *   cohorts     fold lifecycles → price flows → bands.json for the server
 *   verify-events  recompute the event map from the verified ABI on
 *               Blockscout and diff against our constants (run after any
 *               engine upgrade; requires BLOCKSCOUT_PRO_API_KEY)
 *   sample      read every Aerodrome pool's gauge + Aave rates LIVE and
 *               write samples/gauge-emissions-<date>.json in the shape
 *               scripts/lp-sim.py consumes (the model re-run input)
 *   all         scan → timestamps → receipts → cohorts
 *
 * Usage: npm run backfill -- <subcommand> [--to-block N] [--block N]
 *
 *   --block N   (`sample` only, 2026-09-12 slice M) pin EVERY eth_call of the sample to block N and
 *               stamp the sample with that block's timestamp, so the words are the same read the
 *               ledger (`scripts/ledger-read.sh <rpc> N`) and the demo snapshot are taken at —
 *               `scripts/refresh-demo-snapshot.mjs` drives it. GeckoTerminal prices have no block;
 *               they are read at the wall clock, which the sample records as `pricesSampledAt`.
 *   RPC_BATCH_SIZE / RPC_PACE_MS   (env) batch size and pacing for the RPC client — public
 *               endpoints refuse a 20-call burst (`over rate limit`); `RPC_BATCH_SIZE=1
 *               RPC_PACE_MS=400` reads one call at a time, as `cast` is paced in the ledger script.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CURATED_POOLS } from "@zyo/shared";
import { loadConfig } from "./config.js";
import { buildCohortBand, valueLifecycle } from "./cohorts.js";
import { EngineIndexer, EventStore } from "./engine/indexer.js";
import { foldLifecycles } from "./engine/lifecycles.js";
import { syncEngineRegistry } from "./engine/registry.js";
import { TOPICS } from "./engine/events.js";
import { PriceBook } from "./prices.js";
import { priceForToken } from "./server.js";
import { AaveSource } from "./sources/aave.js";
import { BlockscoutSource } from "./sources/blockscout.js";
import { GeckoSource } from "./sources/gecko.js";
import { AERO_ADDRESS, AERODROME_VOTER, GaugeSource, onchainToken1 } from "./sources/gauges.js";
import { RpcClient } from "./sources/rpc.js";
import type { Address, PoolBands } from "./types.js";

const cfg = loadConfig();

function makeRpc(): RpcClient {
  const opts = {
    ...(process.env.RPC_BATCH_SIZE ? { batchSize: Math.max(1, Number(process.env.RPC_BATCH_SIZE)) } : {}),
    ...(process.env.RPC_PACE_MS ? { paceMs: Math.max(0, Number(process.env.RPC_PACE_MS)) } : {}),
  };
  if (cfg.baseRpcUrl) return new RpcClient(cfg.baseRpcUrl, opts);
  if (cfg.blockscoutKey) return new BlockscoutSource(cfg.blockscoutKey).rpc;
  throw new Error(
    "No chain source: set BASE_RPC_URL (any Base RPC) and/or BLOCKSCOUT_PRO_API_KEY in .env"
  );
}

function makeBlockscout(): BlockscoutSource | undefined {
  return cfg.blockscoutKey ? new BlockscoutSource(cfg.blockscoutKey) : undefined;
}

async function scan(toBlock?: number): Promise<void> {
  const rpc = makeRpc();
  const store = new EventStore(cfg.dataDir, cfg.engineVault as Address);
  const indexer = new EngineIndexer(rpc, store, cfg.engineVault as Address, cfg.logChunk);
  const t0 = Date.now();
  const r = await indexer.scan(toBlock, (p) => {
    if (p.scanned % (cfg.logChunk * 20) < cfg.logChunk) {
      console.log(
        `scan: ${p.scanned}/${p.total} blocks, ${p.events} events, ${Math.round((Date.now() - t0) / 1000)}s`
      );
    }
  });
  console.log(`scan done: blocks ${r.from}–${r.to}, ${r.events} events appended, ${r.malformed} malformed logs skipped`);
}

async function timestamps(): Promise<void> {
  const rpc = makeRpc();
  const store = new EventStore(cfg.dataDir, cfg.engineVault as Address);
  const indexer = new EngineIndexer(rpc, store, cfg.engineVault as Address, cfg.logChunk);
  const n = await indexer.fillTimestamps();
  console.log(`timestamps: filled ${n} unique blocks`);
}

async function receipts(): Promise<void> {
  const rpc = makeRpc();
  const bs = makeBlockscout();
  const store = new EventStore(cfg.dataDir, cfg.engineVault as Address);
  const indexer = new EngineIndexer(rpc, store, cfg.engineVault as Address, cfg.logChunk);
  const n = await indexer.fillEntryFlows(
    bs ? (tx) => bs.txTokenTransfers(tx) : undefined,
    (done, total) => console.log(`receipts: ${done}/${total}`)
  );
  console.log(`receipts: enriched ${n} PositionCreated events (${bs ? "blockscout" : "raw-rpc"})`);
  if (bs?.creditsRemaining !== null && bs !== undefined) {
    console.log(`blockscout credits remaining: ${bs.creditsRemaining}`);
  }
}

async function cohorts(): Promise<void> {
  const rpc = makeRpc();
  const store = new EventStore(cfg.dataDir, cfg.engineVault as Address);
  const events = store.readAll();
  if (!events.length) throw new Error("no events — run scan first");

  const { pools, tokenMap, mismatches } = await syncEngineRegistry(rpc, cfg.engineVault as Address);
  for (const m of mismatches) console.warn(`registry: ${m}`);

  const { lifecycles, orphanEvents } = foldLifecycles(events, tokenMap);
  console.log(
    `folded ${lifecycles.length} lifecycles (${lifecycles.filter((l) => l.closedAt).length} closed, ${orphanEvents} orphan events from pre-backfill history)`
  );

  const prices = new PriceBook(new GeckoSource());
  const maxWindow = Math.max(...cfg.cohortWindows);
  await prices.load(maxWindow + 120); // window + longest plausible position age
  const valued = lifecycles.map((lc) => valueLifecycle(lc, prices));
  const now = Math.floor(Date.now() / 1000);
  const head = store.readState()?.nextBlock ?? 0;

  const out: PoolBands[] = pools.map((p) => ({
    poolId: p.curatedId,
    enginePoolId: p.enginePoolId,
    computedAt: new Date().toISOString(),
    asOfBlock: head - 1,
    methodology: "closed-position-flows-v2",
    bands: cfg.cohortWindows.map((w) =>
      buildCohortBand(valued, p.enginePoolId, {
        windowDays: w,
        nowSeconds: now,
        minDaysOpen: cfg.minDaysOpen,
      })
    ),
  }));

  const path = join(cfg.dataDir, "bands.json");
  writeFileSync(path, JSON.stringify(out, null, 2));
  for (const b of out) {
    const w = b.bands.find((x) => x.windowDays === 30) ?? b.bands[0];
    console.log(
      `${b.poolId}: 30d n=${w?.n ?? 0} p25=${w?.p25} p50=${w?.p50} p75=${w?.p75} (excluded ${w?.excluded}: ${JSON.stringify(w?.excludedReasons)})`
    );
  }
  console.log(`bands → ${path}`);
}

async function verifyEvents(): Promise<void> {
  const bs = makeBlockscout();
  if (!bs) throw new Error("verify-events needs BLOCKSCOUT_PRO_API_KEY");
  // Resolve the proxy's CURRENT implementation, then compare its event set
  // against our constants. EIP-1967 implementation slot:
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const implWord = await bs.rpc.call<string>("eth_getStorageAt", [
    cfg.engineVault,
    IMPL_SLOT,
    "latest",
  ]);
  const impl = (`0x${implWord.slice(-40)}`).toLowerCase() as Address;
  console.log(`engine implementation: ${impl}`);
  const abi = (await bs.contractAbi(impl)) as { type: string; name?: string; inputs?: { type: string }[] }[];
  const events = abi.filter((a) => a.type === "event");
  const names = new Set(events.map((e) => `${e.name}(${(e.inputs ?? []).map((i) => i.type).join(",")})`));
  const expected = [
    "PositionCreated(uint256,address,bytes32,int24,int24,uint128,bool)",
    "PositionWithdrawn(uint256,address,uint256,uint256)",
    "FeesHarvested(uint256,address,uint256,uint256)",
    "StakingRewardsClaimed(uint256,address,address,uint256)",
    "PerformanceFeeCollected(uint256,address,uint256,uint256,uint256)",
    "SnuggleRebalanced(uint256,uint256,address,int24,int24,uint256,uint256,bool,uint32)",
  ];
  let ok = true;
  for (const sig of expected) {
    const present = names.has(sig);
    console.log(`${present ? "OK " : "MISSING"} ${sig}`);
    if (!present) ok = false;
  }
  console.log(
    ok
      ? "event map matches the deployed implementation"
      : "EVENT MAP DRIFT — engine upgraded? Re-run the discovery recipe in docs/YIELD-SERVICE.md and update engine/events.ts before trusting new data."
  );
  console.log(`(constants in engine/events.ts: ${Object.keys(TOPICS).length} topics)`);
  if (!ok) process.exitCode = 1;
}

/**
 * Live sample of every Aerodrome pool's gauge + the Aave rates, in the
 * shape scripts/lp-sim.py reads. Every number is a raw chain word or a
 * priced value with its source; nothing is typed.
 */
async function sample(block?: number): Promise<void> {
  const rpc = makeRpc();
  const gecko = new GeckoSource();
  const gauges = new GaugeSource(rpc);
  // Pinned (--block N): the head IS that block, the sample's clock is the block's own timestamp and
  // every eth_call below carries the block tag. Unpinned: the live service's shape, unchanged.
  const head = block ?? (await rpc.blockNumber());
  const blockTs = block === undefined ? undefined : await rpc.blockTimestamp(block);
  const aave = blockTs === undefined ? new AaveSource(rpc) : new AaveSource(rpc, () => blockTs * 1000);
  const wallClock = new Date().toISOString();
  const rates = await aave.sample(block);
  const live = new Map<string, Awaited<ReturnType<GeckoSource["liveSample"]>>>();
  // GeckoTerminal's public tier allows about 30 requests a minute and the source's own retries
  // (4 attempts, backing off) count against it, so a 12-pool burst that trips the limit once keeps
  // tripping it. GECKO_MIN_INTERVAL_MS spaces the per-pool requests (2200 ≈ 27/min); default 0
  // keeps the old behaviour (2026-09-12, slice K: four bursts in a row were refused).
  const paceMs = Number(process.env.GECKO_MIN_INTERVAL_MS ?? "0");
  // Only the Aerodrome pools are sampled below (the gauge loop) and AERO's price is found among
  // them; the three non-Aerodrome curated pools were fetched and never read — 12 → 9 requests.
  for (const p of CURATED_POOLS) {
    if (!p.poolAddress || p.dex !== "AERODROME") continue;
    live.set(p.id, await gecko.liveSample(p.id, p.poolAddress as Address, p.feeTierBps));
    if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
  }
  let aeroUsd: number | undefined;
  for (const s of live.values()) aeroUsd ??= priceForToken(s, AERO_ADDRESS);
  if (aeroUsd === undefined) throw new Error("no AERO/USD price in live samples");
  const pools: Record<string, unknown> = {};
  for (const p of CURATED_POOLS.filter((x) => x.dex === "AERODROME" && x.poolAddress)) {
    const l = live.get(p.id)!;
    const t1 = onchainToken1(p.token0, p.token1);
    if (!t1) throw new Error(`${p.id}: unknown token pair`);
    const token1Usd = priceForToken(l, t1.address);
    if (token1Usd === undefined) throw new Error(`${p.id}: no token1 price`);
    const e = await gauges.sample(p.id, p.poolAddress as Address, {
      aeroUsd, poolTvlUsd: l.tvlUsd, token1Usd, token1Decimals: t1.decimals,
      ...(blockTs === undefined ? {} : { nowSeconds: blockTs }),
    }, p.gauge as Address | undefined, block);
    pools[p.id] = {
      pool: e.pool, gauge: e.gauge, rewardRateWeiPerSec: e.rewardRateWeiPerSec, periodFinish: e.periodFinish,
      epochActive: e.epochActive, poolTvlUsd: l.tvlUsd, vol24Usd: l.volume24hUsd, wholePoolAprPct: e.wholePoolAprPct,
      sqrtPriceX96: e.sqrtPriceX96, feeBpsLive: e.feePips / 100, token1: t1.address, dec1: t1.decimals, token1Usd,
      stakedLiquidity: e.stakedLiquidity, aprByWidthPct: e.aprByWidthPct, protocol: p.protocol, pairClass: p.pairClass,
    };
    console.log(`${p.id}: epochActive=${e.epochActive} wholePool=${e.wholePoolAprPct}% staked=${e.stakedLiquidity}`);
  }
  const out = {
    sampledAt: rates.sampledAt, block: head, aeroUsd, voter: AERODROME_VOTER,
    // A pinned sample says so: the chain words are as of `block` (its timestamp is `sampledAt`);
    // the GeckoTerminal prices (AERO, token1, TVL) were read at `pricesSampledAt` on the wall clock.
    ...(blockTs === undefined ? {} : { pinned: true, blockTimestamp: blockTs, pricesSampledAt: wallClock }),
    method: "APR(bps)=rewardRate*yr*AEROusd / V_staked(w); w=1.0001^(bps/2)-1; V_staked(w)=stakedLiquidity*sqrtP*(2-sqrt(1-w)-1/sqrt(1+w))/10^dec1*token1Usd (marginal, in-range, staked); wholePool=rewardRate*yr*AEROusd/poolTVL",
    aave: rates, pools,
  };
  const path = join(cfg.samplesDir, `gauge-emissions-${rates.sampledAt.slice(0, 10)}.json`);
  writeFileSync(path, JSON.stringify(out, null, 1));
  console.log(`sample → ${path} (borrow ${rates.borrow.variableBorrowAprPct}%${block === undefined ? "" : `, pinned to block ${block}`})`);
}

const [cmd, ...rest] = process.argv.slice(2);
const toBlockArg = rest.includes("--to-block")
  ? Number(rest[rest.indexOf("--to-block") + 1])
  : undefined;
const blockArg = rest.includes("--block") ? Number(rest[rest.indexOf("--block") + 1]) : undefined;
if (blockArg !== undefined && !(Number.isInteger(blockArg) && blockArg > 0)) {
  console.error(`--block must be a positive block number, got ${rest[rest.indexOf("--block") + 1]}`);
  process.exit(2);
}

const run = async () => {
  switch (cmd) {
    case "scan": return scan(toBlockArg);
    case "timestamps": return timestamps();
    case "receipts": return receipts();
    case "cohorts": return cohorts();
    case "verify-events": return verifyEvents();
    case "sample": return sample(blockArg);
    case "all":
      await scan(toBlockArg);
      await timestamps();
      await receipts();
      return cohorts();
    default:
      console.log("usage: npm run backfill -- <scan|timestamps|receipts|cohorts|verify-events|sample|all> [--to-block N] [sample --block N]");
      process.exitCode = 2;
  }
};

run().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
