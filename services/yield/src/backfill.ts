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
 *   all         scan → timestamps → receipts → cohorts
 *
 * Usage: npm run backfill -- <subcommand> [--to-block N]
 */

import { join } from "node:path";
import { loadConfig } from "./config.js";
import { buildCohortBand, valueLifecycle } from "./cohorts.js";
import { atomicWriteFileSync, EngineIndexer, EventStore } from "./engine/indexer.js";
import { foldLifecycles } from "./engine/lifecycles.js";
import { syncEngineRegistry } from "./engine/registry.js";
import { TOPICS } from "./engine/events.js";
import { PriceBook } from "./prices.js";
import { BlockscoutSource } from "./sources/blockscout.js";
import { GeckoSource } from "./sources/gecko.js";
import { RpcClient } from "./sources/rpc.js";
import type { Address, PoolBands } from "./types.js";

const cfg = loadConfig();

function makeRpc(): RpcClient {
  if (cfg.baseRpcUrl) return new RpcClient(cfg.baseRpcUrl);
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
  const indexer = new EngineIndexer(rpc, store, cfg.engineVault as Address, {
    logChunk: cfg.logChunk,
    startBlock: cfg.startBlock,
  });
  const t0 = Date.now();
  const r = await indexer.scan(toBlock, (p) => {
    if (p.scanned % (cfg.logChunk * 20) < cfg.logChunk) {
      console.log(
        `scan: ${p.scanned}/${p.total} blocks, ${p.events} events, ${Math.round((Date.now() - t0) / 1000)}s`
      );
    }
  });
  console.log(`scan done: blocks ${r.from}–${r.to}, ${r.events} events appended`);
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
  const internalHarvests = lifecycles.reduce((s, l) => s + l.internalHarvests, 0);
  const unattributed = lifecycles.filter((l) => l.unattributed).length;
  console.log(
    `folded ${lifecycles.length} lifecycles (${lifecycles.filter((l) => l.closedAt).length} closed, ` +
      `${orphanEvents} orphan events from pre-backfill history, ` +
      `${internalHarvests} internal (non-owner) harvests, ${unattributed} unattributed lifecycles)`
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
    methodology: "closed-position-flows-v1",
    bands: cfg.cohortWindows.map((w) =>
      buildCohortBand(valued, p.enginePoolId, {
        windowDays: w,
        nowSeconds: now,
        minDaysOpen: cfg.minDaysOpen,
      })
    ),
  }));

  const path = join(cfg.dataDir, "bands.json");
  atomicWriteFileSync(path, JSON.stringify(out, null, 2)); // tmp+fsync+rename — the server may read concurrently
  for (const b of out) {
    const w = b.bands.find((x) => x.windowDays === 30) ?? b.bands[0];
    console.log(
      `${b.poolId}: 30d n=${w?.n ?? 0} p25=${w?.p25} p50=${w?.p50} p75=${w?.p75} (excluded ${w?.excluded})`
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

const [cmd, ...rest] = process.argv.slice(2);
let toBlockArg: number | undefined;
if (rest.includes("--to-block")) {
  const raw = rest[rest.indexOf("--to-block") + 1];
  const parsed = Number(raw);
  if (raw === undefined || !Number.isInteger(parsed) || parsed <= 0) {
    // `--to-block abc` used to become NaN and silently scan NOTHING while
    // claiming success. A bad bound is an error, not an empty run.
    console.error(`--to-block: not a positive integer: ${raw}`);
    process.exit(2);
  }
  toBlockArg = parsed;
}

const run = async () => {
  switch (cmd) {
    case "scan": return scan(toBlockArg);
    case "timestamps": return timestamps();
    case "receipts": return receipts();
    case "cohorts": return cohorts();
    case "verify-events": return verifyEvents();
    case "all":
      await scan(toBlockArg);
      await timestamps();
      await receipts();
      return cohorts();
    default:
      console.log("usage: npm run backfill -- <scan|timestamps|receipts|cohorts|verify-events|all> [--to-block N]");
      process.exitCode = 2;
  }
};

run().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
