import { test } from "node:test";
import assert from "node:assert/strict";
import { AAVE_V3, BASE_TOKENS, PERMIT2 } from "@zyo/shared";
import { decodeReserve, readAccount, readDeployment, readKeeperGrant, readMarket, readPendingVenues, readVenueHealth, safeMulticall, type ReadClient } from "../lib/reads";
import { accountHf, hfBand } from "../lib/math";
import { DEMO_MARKET } from "../lib/demo";
import { UNWIND_SELECTOR } from "../lib/plan";
import { ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { LP_VENUE_ABI } from "../lib/abi/oilskin";

/** Tuples shaped exactly as Aave's PoolDataProvider returns them, carrying the demo snapshot's words (the
 * 2026-09-12 re-read at block 51,226,072, VERIFIED-BASE-FACTS Addendum 14; rates are the 4-dp words the demo
 * carries, built back into ray — the raw ray words are in the addendum). */
const CFG = {
  cbBTC: [8n, 7300n, 7800n, 10750n, 5000n, true, true, false, true, false],
  WETH: [18n, 8000n, 8300n, 10500n, 1500n, true, true, false, true, false],
  USDC: [6n, 7500n, 7800n, 10500n, 1000n, true, true, false, true, false],
  cbZEC: [0n, 0n, 0n, 0n, 0n, false, false, false, false, false],
} as const;
const ray = (pct: number) => BigInt(Math.round(pct * 1e6)) * 10n ** 19n; // pct → ray
const DATA = {
  cbBTC: [0n, 0n, 0n, 0n, 0n, ray(DEMO_MARKET.reserves.cbBTC!.supplyAprPct), ray(DEMO_MARKET.reserves.cbBTC!.variableBorrowAprPct), 0n, 0n, 0n, 0n, 0n],
  WETH: [0n, 0n, 0n, 0n, 0n, ray(DEMO_MARKET.reserves.WETH!.supplyAprPct), ray(DEMO_MARKET.reserves.WETH!.variableBorrowAprPct), 0n, 0n, 0n, 0n, 0n],
  USDC: [0n, 0n, 0n, 0n, 0n, ray(DEMO_MARKET.reserves.USDC!.supplyAprPct), ray(DEMO_MARKET.reserves.USDC!.variableBorrowAprPct), 0n, 0n, 0n, 0n, 0n],
  cbZEC: [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
} as const;
const e8 = (usd: number) => BigInt(Math.round(usd * 1e8)); // the oracle's 8-decimal answer
const PRICE = { cbBTC: e8(DEMO_MARKET.reserves.cbBTC!.priceUsd), WETH: e8(DEMO_MARKET.reserves.WETH!.priceUsd), USDC: 100_000_000n, cbZEC: 0n } as const;
/** The fake account: 0.5 cbBTC on Aave borrowed to 40 % LTV (HF = 0.78 / 0.40 = 1.95) and, in the venue tests,
 * 1 cbBTC on a Morpho-style venue at HF 1.72. Every USDC figure is derived from the snapshot price, so the app's
 * own cross-check (its prices against a venue's claimed HF) sees one consistent world whatever the ledger read says
 * (15,926.178 USDC of Aave debt at the 2026-09-05 price, 15,428.166 at the 2026-09-12 one). */
const PX = DEMO_MARKET.reserves.cbBTC!.priceUsd;
const e6 = (usdc: number) => BigInt(Math.round(usdc * 1e6));
const AAVE_COLLATERAL_USD = 0.5 * PX;
const AAVE_DEBT_USDC = 0.5 * PX * 0.4;
const AAVE_AVAILABLE_USD = 0.5 * PX * 0.73 - AAVE_DEBT_USDC;
const MORPHO_DEBT_USDC = Math.round((PX * 0.86) / 1.72);

type Sym = keyof typeof CFG;
const symOf = (addr: string): Sym => (Object.keys(BASE_TOKENS) as Sym[]).find((s) => BASE_TOKENS[s as keyof typeof BASE_TOKENS].address.toLowerCase() === addr.toLowerCase())!;

/** A fake viem client that answers the same calls the real one would. */
function fakeClient(opts: { multicallThrows?: boolean; deployed?: boolean; account?: string; positions?: bigint[]; positionsFault?: { code: number; index: bigint } | "plain"; log?: string[]; entryHfWad?: bigint | Error } = {}): ReadClient {
  const answer = (c: { address: string; functionName: string; args?: readonly unknown[] }): unknown => {
    opts.log?.push(c.functionName);
    const asset = symOf(String(c.args?.[0] ?? ""));
    switch (c.functionName) {
      case "getReserveConfigurationData":
        return [...CFG[asset]];
      case "getReserveData":
        return [...DATA[asset]];
      case "getAssetPrice":
        return PRICE[asset];
      case "balanceOf":
        return c.address.toLowerCase() === BASE_TOKENS.cbBTC.address.toLowerCase() ? 123_000_000n : 0n;
      case "accountOf":
        return opts.account ?? "0x2222222222222222222222222222222222222222";
      case "getUserAccountData":
        return [e8(AAVE_COLLATERAL_USD), e8(AAVE_DEBT_USDC), e8(AAVE_AVAILABLE_USD), 7800n, 7300n, 1_950_000_000_000_000_000n];
      case "getUserReserveData": {
        const a = symOf(String(c.args?.[0]));
        if (a === "cbBTC") return [50_000_000n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, true];
        if (a === "USDC") return [0n, 0n, e6(AAVE_DEBT_USDC), 0n, 0n, 0n, 0n, 0n, false];
        return [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, false];
      }
      case "entryHfWad":
        if (opts.entryHfWad instanceof Error) throw opts.entryHfWad;
        return opts.entryHfWad ?? 0n;
      case "positionsOf":
        if (opts.positionsFault === "plain") throw new Error("rpc: connection reset");
        if (opts.positionsFault) {
          throw new ContractFunctionRevertedError({
            abi: LP_VENUE_ABI,
            functionName: "positionsOf",
            data: encodeErrorResult({ abi: LP_VENUE_ABI, errorName: "EnumerationAmbiguous", args: [opts.positionsFault.code, opts.positionsFault.index, "0x"] }),
          });
        }
        return opts.positions ?? [7n, 9n];
      default:
        throw new Error(`unexpected ${c.functionName}`);
    }
  };
  return {
    async multicall({ contracts }) {
      if (opts.multicallThrows) throw new Error("multicall3 missing");
      return (contracts as { address: string; functionName: string; args?: readonly unknown[] }[]).map((c) => {
        try {
          return { status: "success" as const, result: answer(c) };
        } catch {
          return { status: "failure" as const };
        }
      });
    },
    async readContract(c) {
      return answer(c);
    },
    async getCode({ address }) {
      return opts.deployed === false ? "0x" : address.toLowerCase() === "0x2222222222222222222222222222222222222222" ? "0x6080" : "0x";
    },
  };
}

test("decodeReserve: cbBTC config + rates + oracle price → the VERIFIED numbers", () => {
  const r = decodeReserve("cbBTC", [...CFG.cbBTC], [...DATA.cbBTC], PRICE.cbBTC)!;
  assert.equal(r.liquidationThresholdBps, 7800);
  assert.equal(r.ltvBps, 7300);
  assert.equal(r.liquidationBonusBps, 750);
  assert.equal(r.usageAsCollateralEnabled, true);
  assert.ok(Math.abs(r.variableBorrowAprPct - DEMO_MARKET.reserves.cbBTC!.variableBorrowAprPct) < 1e-9);
  assert.ok(Math.abs(r.supplyAprPct - DEMO_MARKET.reserves.cbBTC!.supplyAprPct) < 1e-9);
  assert.ok(Math.abs(r.priceUsd - DEMO_MARKET.reserves.cbBTC!.priceUsd) < 1e-9);
});

test("decodeReserve: an unlisted reserve (all zeros, cbZEC) → null; half-read → null", () => {
  assert.equal(decodeReserve("cbZEC", [...CFG.cbZEC], [...DATA.cbZEC], 0n), null);
  assert.equal(decodeReserve("cbBTC", null, [...DATA.cbBTC], PRICE.cbBTC), null);
  assert.equal(decodeReserve("cbBTC", [...CFG.cbBTC], null, PRICE.cbBTC), null);
  const noPrice = decodeReserve("cbBTC", [...CFG.cbBTC], [...DATA.cbBTC], null)!;
  assert.ok(Number.isNaN(noPrice.priceUsd));
});

test("readMarket: live decode agrees with the demo snapshot field-for-field", async () => {
  const m = await readMarket(fakeClient());
  assert.equal(m.source, "live");
  assert.ok(Math.abs(m.usdcBorrowAprPct - DEMO_MARKET.usdcBorrowAprPct) < 1e-9);
  for (const s of ["cbBTC", "WETH", "USDC"] as const) {
    const live = m.reserves[s]!;
    const snap = DEMO_MARKET.reserves[s]!;
    assert.equal(live.liquidationThresholdBps, snap.liquidationThresholdBps, `${s} LT`);
    assert.equal(live.ltvBps, snap.ltvBps, `${s} LTV`);
    assert.equal(live.liquidationBonusBps, snap.liquidationBonusBps, `${s} bonus`);
    assert.ok(Math.abs(live.variableBorrowAprPct - snap.variableBorrowAprPct) < 1e-9, `${s} borrow`);
    assert.ok(Math.abs(live.priceUsd - snap.priceUsd) < 1e-6, `${s} price`);
  }
  assert.equal(m.reserves.cbZEC, null);
});

test("readMarket throws (fail closed) when USDC is unreadable", async () => {
  const c = fakeClient();
  const broken: ReadClient = {
    ...c,
    async multicall(args) {
      const res = await c.multicall(args);
      return res.map((r, i) => ((args.contracts as { args?: unknown[] }[])[i].args?.[0] === BASE_TOKENS.USDC.address ? { status: "failure" as const } : r));
    },
  };
  await assert.rejects(readMarket(broken), /USDC reserve unreadable/);
});

test("safeMulticall falls back to per-call reads when the batch throws", async () => {
  const log: string[] = [];
  const out = await safeMulticall(fakeClient({ multicallThrows: true, log }), [
    { address: AAVE_V3.oracle, abi: [], functionName: "getAssetPrice", args: [BASE_TOKENS.cbBTC.address] },
    { address: AAVE_V3.oracle, abi: [], functionName: "getAssetPrice", args: [BASE_TOKENS.WETH.address] },
  ]);
  assert.deepEqual(out, [PRICE.cbBTC, PRICE.WETH]);
  assert.equal(log.length, 2);
});

test("readAccount: deployed account → Aave data, holdings, USDC debt, LP ids", async () => {
  const market = await readMarket(fakeClient());
  const a = await readAccount(fakeClient(), "0x1111111111111111111111111111111111111111", market, {
    factory: "0x3333333333333333333333333333333333333333",
    lpVenue: "0x5555555555555555555555555555555555555555",
  });
  assert.equal(a.account, "0x2222222222222222222222222222222222222222");
  assert.equal(a.deployed, true);
  assert.ok(Math.abs(a.aave!.totalCollateralUsd - AAVE_COLLATERAL_USD) < 1e-6);
  assert.ok(Math.abs(a.aave!.totalDebtUsd - AAVE_DEBT_USDC) < 1e-6);
  assert.equal(a.aave!.currentLiquidationThresholdBps, 7800);
  assert.ok(Math.abs(a.aave!.healthFactor - 1.95) < 1e-9);
  assert.equal(a.collateral.length, 1);
  assert.equal(a.collateral[0].symbol, "cbBTC");
  assert.ok(Math.abs(a.collateral[0].amount - 0.5) < 1e-12);
  assert.ok(Math.abs(a.collateral[0].usd - AAVE_COLLATERAL_USD) < 1e-6);
  assert.ok(Math.abs(a.debtUsdc - AAVE_DEBT_USDC) < 1e-9);
  assert.deepEqual(a.lpPositionIds, [7n, 9n]);
  assert.equal(a.lpUnreadable, null);
  assert.equal(a.walletBalances.cbBTC, 123_000_000n);
  assert.equal(a.entryHf, null);
  assert.equal(a.entryHfStatus, "no_router", "no router given: the record was not asked for");
});

test("readAccount: the router's entry-HF record (A4) — recorded, none (0), and unreadable are three different statements", async () => {
  const market = await readMarket(fakeClient());
  const owner = "0x1111111111111111111111111111111111111111" as const;
  const opts = { factory: "0x3333333333333333333333333333333333333333" as const, router: "0x4444444444444444444444444444444444444444" as const };
  const recorded = await readAccount(fakeClient({ entryHfWad: 1_950_000_000_000_000_000n }), owner, market, opts);
  assert.equal(recorded.entryHf, 1.95);
  assert.equal(recorded.entryHfStatus, "recorded");
  const none = await readAccount(fakeClient({ entryHfWad: 0n }), owner, market, opts);
  assert.equal(none.entryHf, null);
  assert.equal(none.entryHfStatus, "none");
  const bad = await readAccount(fakeClient({ entryHfWad: new Error("rpc: timeout") }), owner, market, opts);
  assert.equal(bad.entryHf, null);
  assert.equal(bad.entryHfStatus, "unreadable");
  assert.ok(bad.aave, "the rest of the account still reads");
});

test("readAccount: a positionsOf the venue refuses is UNREADABLE with the fault named — never an empty list (slice A, RISKS §12)", async () => {
  const market = await readMarket(fakeClient());
  const opts = { factory: "0x3333333333333333333333333333333333333333" as const, lpVenue: "0x5555555555555555555555555555555555555555" as const };
  const owner = "0x1111111111111111111111111111111111111111" as const;
  const oog = await readAccount(fakeClient({ positionsFault: { code: 1, index: 3n } }), owner, market, opts);
  assert.match(oog.lpUnreadable!, /^LP positions unreadable:/);
  assert.match(oog.lpUnreadable!, /ProbeOutOfGas at index 3/);
  assert.match(oog.lpUnreadable!, /not a statement that the account holds no positions/);
  assert.deepEqual(oog.lpPositionIds, []);
  assert.deepEqual(oog.lpPositions, []);
  assert.ok(oog.aave, "the rest of the account still reads");

  const owner2 = await readAccount(fakeClient({ positionsFault: { code: 7, index: 1n } }), owner, market, opts);
  assert.match(owner2.lpUnreadable!, /OwnerMismatch at index 1/);

  // Any other failure of the read is unreadable too, with what is known, not an empty list.
  const plain = await readAccount(fakeClient({ positionsFault: "plain" }), owner, market, opts);
  assert.match(plain.lpUnreadable!, /positionsOf failed \(rpc: connection reset\)/);
  assert.deepEqual(plain.lpPositionIds, []);

  // No LP venue configured: nothing to read, nothing unreadable.
  const none = await readAccount(fakeClient(), owner, market, { factory: opts.factory });
  assert.equal(none.lpUnreadable, null);
  assert.deepEqual(none.lpPositionIds, []);
});

test("readAccount: no factory configured → wallet balances only; predicted-but-undeployed → address, no positions", async () => {
  const market = await readMarket(fakeClient());
  const none = await readAccount(fakeClient(), "0x1111111111111111111111111111111111111111", market, {});
  assert.equal(none.account, null);
  assert.equal(none.deployed, false);
  assert.equal(none.walletBalances.cbBTC, 123_000_000n);

  const pred = await readAccount(fakeClient({ deployed: false }), "0x1111111111111111111111111111111111111111", market, { factory: "0x3333333333333333333333333333333333333333" });
  assert.equal(pred.account, "0x2222222222222222222222222222222222222222");
  assert.equal(pred.deployed, false);
  assert.equal(pred.aave, null);
  assert.deepEqual(pred.lpPositionIds, []);
});

// ---------------------------------------------------------------------------
// Deployment discovery, the venue timelock, and the keeper grant
// ---------------------------------------------------------------------------

const ROUTER = "0x4444444444444444444444444444444444444444" as const;
const REGISTRY = "0x5555555555555555555555555555555555555555" as const;
const LP_VENUE = "0x6666666666666666666666666666666666666666" as const;
const AAVE_VENUE = "0x7777777777777777777777777777777777777777" as const;
const SWAP = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const ENGINE = "0x8888888888888888888888888888888888888888" as const;
const KEEPER = "0x9999999999999999999999999999999999999999" as const;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

function chainClient(answer: (c: { address: string; functionName: string; args?: readonly unknown[] }) => unknown): ReadClient {
  return {
    async multicall() {
      throw new Error("no multicall3 here — exercise the per-call fallback");
    },
    async readContract(c) {
      return answer(c as never);
    },
    async getCode() {
      return "0x60";
    },
  };
}

const deploymentAnswer =
  (over: Record<string, unknown> = {}) =>
  (c: { functionName: string }): unknown => {
    const table: Record<string, unknown> = {
      REGISTRY,
      LP_VENUE,
      SWAP,
      PERMIT2,
      venueOf: AAVE_VENUE,
      previousVenues: [],
      isEnabled: true,
      PROVIDER: AAVE_V3.poolAddressesProvider,
      enabled: true,
      liquidationThresholdBps: 7800n,
      ENGINE,
      // The registry's entry floor (A4): 1.55 at 18 decimals.
      entryHfFloorWad: 1_550_000_000_000_000_000n,
      ...over,
    };
    if (!(c.functionName in table)) throw new Error(`unexpected ${c.functionName}`);
    const v = table[c.functionName];
    if (v instanceof Error) throw v;
    return v;
  };

test("readDeployment discovers the swap adapter, and refuses a router without one", async () => {
  const d = await readDeployment(chainClient(deploymentAnswer()), "0x3333333333333333333333333333333333333333", ROUTER, KEEPER);
  assert.equal(d.swapAdapter, SWAP);
  assert.equal(d.registry, REGISTRY);
  assert.equal(d.lpVenue, LP_VENUE);
  assert.equal(d.aaveVenue, AAVE_VENUE);
  assert.equal(d.engine, ENGINE);
  assert.equal(d.entryHfFloor, 1.55, "the registry's floor, read — the slider's minimum");
  assert.equal(d.demo, false);
  // Without a readable floor the slider has no minimum: refused, not assumed.
  await assert.rejects(() => readDeployment(chainClient(deploymentAnswer({ entryHfFloorWad: 0n })), "0x3333333333333333333333333333333333333333", ROUTER, KEEPER), /entry floor unreadable/);
  // Without the adapter the UI cannot show the floor the chain will enforce on
  // an unwind, so the deployment is refused rather than half-trusted.
  await assert.rejects(() => readDeployment(chainClient(deploymentAnswer({ SWAP: ZERO })), "0x3333333333333333333333333333333333333333", ROUTER, KEEPER), /swap adapter/);
  await assert.rejects(
    () => readDeployment(chainClient(deploymentAnswer({ PERMIT2: "0x000000000000000000000000000000000000dEaD" })), "0x3333333333333333333333333333333333333333", ROUTER, KEEPER),
    /canonical Permit2/,
  );
});

test("readDeployment: LP_VENUE_DIRECT is read (zero or an old router without the view → null; an address → the direct venue)", async () => {
  const none = await readDeployment(chainClient(deploymentAnswer()), "0x3333333333333333333333333333333333333333", ROUTER, KEEPER);
  assert.equal(none.lpVenueDirect, null, "a router without the view: the row fails, read as none");
  const zero = await readDeployment(chainClient(deploymentAnswer({ LP_VENUE_DIRECT: ZERO })), "0x3333333333333333333333333333333333333333", ROUTER, KEEPER);
  assert.equal(zero.lpVenueDirect, null);
  const DIRECT = "0x1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d";
  const some = await readDeployment(chainClient(deploymentAnswer({ LP_VENUE_DIRECT: DIRECT })), "0x3333333333333333333333333333333333333333", ROUTER, KEEPER);
  assert.equal(some.lpVenueDirect, DIRECT);
});

test("readDeployment: every enabled asset on an AaveV3Venue over the shared provider → no unsupported venues", async () => {
  const d = await readDeployment(chainClient(deploymentAnswer()), "0x3333333333333333333333333333333333333333", ROUTER, KEEPER);
  assert.deepEqual(d.unsupportedVenues, []);
});

test("M-HIGH-2: a Morpho venue that answers ICollateralVenue is SUPPORTED even though it has no PROVIDER(); a venue that answers nothing is not", async () => {
  const MORPHO_VENUE = "0xdddddddddddddddddddddddddddddddddddddddd";
  const DEAD_VENUE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const client = chainClient((c) => {
    if (c.functionName === "venueOf") {
      const asset = String(c.args?.[0] ?? "").toLowerCase();
      if (asset === BASE_TOKENS.cbBTC.address.toLowerCase()) return MORPHO_VENUE;
      if (asset === BASE_TOKENS.WETH.address.toLowerCase()) return DEAD_VENUE;
      return AAVE_VENUE;
    }
    if (c.address.toLowerCase() === DEAD_VENUE) throw new Error("execution reverted: no such function");
    if (c.functionName === "PROVIDER" && c.address.toLowerCase() === MORPHO_VENUE) throw new Error("execution reverted: no such function");
    if (c.functionName === "liquidationThresholdBps" && c.address.toLowerCase() === MORPHO_VENUE) return 8600n; // the LLTV, read live
    return deploymentAnswer()(c);
  });
  const d = await readDeployment(client, "0x3333333333333333333333333333333333333333", ROUTER, KEEPER);
  assert.deepEqual(d.unsupportedVenues, ["WETH"], "cbBTC on Morpho is readable; WETH on a venue that answers nothing is not; cbZEC is disabled");
});

test("M-HIGH-2: a venue over a DIFFERENT Aave provider is readable too; a zero threshold for an enabled asset is unsupported; a disabled asset is never reported", async () => {
  const OTHER_PROVIDER = "0x00000000000000000000000000000000000000ff";
  const readable = chainClient((c) => {
    if (c.functionName === "PROVIDER") return OTHER_PROVIDER;
    return deploymentAnswer()(c);
  });
  assert.deepEqual((await readDeployment(readable, "0x3333333333333333333333333333333333333333", ROUTER, KEEPER)).unsupportedVenues, []);

  const zeroLt = chainClient((c) => {
    if (c.functionName === "isEnabled") return String(c.args?.[0] ?? "").toLowerCase() !== BASE_TOKENS.cbZEC.address.toLowerCase();
    if (c.functionName === "liquidationThresholdBps") return String(c.args?.[0] ?? "").toLowerCase() === BASE_TOKENS.WETH.address.toLowerCase() ? 0n : 7800n;
    return deploymentAnswer()(c);
  });
  assert.deepEqual((await readDeployment(zeroLt, "0x3333333333333333333333333333333333333333", ROUTER, KEEPER)).unsupportedVenues, ["WETH"]);

  const venueOff = chainClient((c) => {
    if (c.functionName === "isEnabled") return String(c.args?.[0] ?? "").toLowerCase() !== BASE_TOKENS.cbZEC.address.toLowerCase();
    return c.functionName === "enabled" ? false : deploymentAnswer()(c);
  });
  assert.deepEqual((await readDeployment(venueOff, "0x3333333333333333333333333333333333333333", ROUTER, KEEPER)).unsupportedVenues, ["cbBTC", "WETH"], "a venue that reports enabled() == false serves nothing; the disabled cbZEC is not reported");
});

// ---------------------------------------------------------------------------
// The venue-aware account read (audit wave 2, M-HIGH-2)
// ---------------------------------------------------------------------------

const MORPHO_VENUE = "0xdddddddddddddddddddddddddddddddddddddddd" as const;
const DEAD_VENUE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const;
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const WAD = 10n ** 18n;

/**
 * The fake client from above (Aave pool: 0.5 cbBTC, 15,926 USDC debt, HF 1.95) plus a registry and
 * venues. `venueTable` answers per venue address and function; anything it does not name reverts.
 */
function venueClient(venueTable: Record<string, Record<string, (args?: readonly unknown[]) => unknown>>, registry: Record<string, (asset: string) => unknown>, base = fakeClient()): ReadClient {
  const answer = (c: { address: string; functionName: string; args?: readonly unknown[] }): unknown => {
    const addr = c.address.toLowerCase();
    if (addr === REGISTRY.toLowerCase()) {
      const fn = registry[c.functionName];
      if (!fn) throw new Error(`registry: unexpected ${c.functionName}`);
      return fn(String(c.args?.[0] ?? "").toLowerCase());
    }
    const venue = venueTable[addr];
    if (venue) {
      const fn = venue[c.functionName];
      if (!fn) throw new Error(`execution reverted: ${c.functionName} not on this venue`);
      return fn(c.args);
    }
    return base.readContract(c as never);
  };
  return {
    async multicall({ contracts }) {
      return Promise.all(
        (contracts as { address: string; functionName: string; args?: readonly unknown[] }[]).map(async (c) => {
          try {
            return { status: "success" as const, result: await answer(c) };
          } catch {
            return { status: "failure" as const };
          }
        }),
      );
    },
    async readContract(c) {
      return answer(c as never);
    },
    getCode: base.getCode,
  };
}

/** An AaveV3Venue over the shared provider that mirrors the fake pool (HF 1.95, the 40 % debt, 0.5 cbBTC). */
const aaveVenueMirror = (hfWad = 1_950_000_000_000_000_000n) => ({
  PROVIDER: () => AAVE_V3.poolAddressesProvider,
  healthFactor: () => hfWad,
  debt: () => e6(AAVE_DEBT_USDC),
  collateral: (args?: readonly unknown[]) => (String(args?.[1] ?? "").toLowerCase() === BASE_TOKENS.cbBTC.address.toLowerCase() ? 50_000_000n : 0n),
  liquidationThresholdBps: (args?: readonly unknown[]) => (String(args?.[0] ?? "").toLowerCase() === BASE_TOKENS.cbBTC.address.toLowerCase() ? 7800n : 8300n),
  enabled: () => true,
});
/** A Morpho-style venue: 1 cbBTC against PX × 0.86 / 1.72 USDC in its cbBTC market, HF = 0.86 / 0.50 = 1.72 (no PROVIDER view). */
const morphoVenue = (hfWad = 1_720_000_000_000_000_000n, debt = e6(MORPHO_DEBT_USDC)) => ({
  healthFactor: () => hfWad,
  debt: (args?: readonly unknown[]) => (String(args?.[1] ?? "").toLowerCase() === BASE_TOKENS.USDC.address.toLowerCase() ? debt : 0n),
  collateral: (args?: readonly unknown[]) => (String(args?.[1] ?? "").toLowerCase() === BASE_TOKENS.cbBTC.address.toLowerCase() ? 100_000_000n : 0n),
  liquidationThresholdBps: () => 8600n,
  enabled: () => true,
});
const registryAaveOnly = {
  venueOf: () => AAVE_VENUE,
  previousVenues: () => [],
  isEnabled: (asset: string) => asset !== BASE_TOKENS.cbZEC.address.toLowerCase(),
};
/** cbBTC moved to Morpho by acceptVenue: the Aave venue is remembered as its previous venue. */
const registryCbbtcOnMorpho = {
  venueOf: (asset: string) => (asset === BASE_TOKENS.cbBTC.address.toLowerCase() ? MORPHO_VENUE : AAVE_VENUE),
  previousVenues: (asset: string) => (asset === BASE_TOKENS.cbBTC.address.toLowerCase() ? [AAVE_VENUE] : []),
  isEnabled: (asset: string) => asset !== BASE_TOKENS.cbZEC.address.toLowerCase(),
};
const readOpts = { factory: "0x3333333333333333333333333333333333333333", lpVenue: LP_VENUE, registry: REGISTRY } as const;

test("venue-aware readAccount: an Aave-only registry reads the Aave venue, cross-checks it against the pool, and shows the pool's HF", async () => {
  const market = await readMarket(fakeClient());
  const client = venueClient({ [AAVE_VENUE.toLowerCase()]: aaveVenueMirror() }, registryAaveOnly);
  const a = await readAccount(client, OWNER, market, readOpts);
  assert.ok(a.venues);
  assert.equal(a.venues!.venues.length, 1);
  assert.equal(a.venues!.venues[0].kind, "aave");
  assert.equal(a.venues!.venues[0].current, true);
  assert.deepEqual(a.venues!.venues[0].assets, ["cbBTC", "WETH", "cbZEC"]);
  assert.ok(Math.abs((a.venues!.healthFactor ?? 0) - 1.95) < 1e-9);
  assert.equal(a.venues!.otherDebtUsdc, 0);
  assert.equal(accountHf(a), a.aave!.healthFactor, "same number as before the venue-aware read existed");
  assert.equal(a.collateral.length, 1, "no duplicate row for the Aave venue's collateral");
});

test("M-HIGH-2: a Morpho position is VISIBLE — HF 1.72 from the venue, its debt and collateral on the page, the Aave leg alone would have said no debt", async () => {
  const market = await readMarket(fakeClient());
  // The pool leg has no position for this account here: make the fake pool empty to isolate the Morpho view.
  const emptyPool = fakeClient();
  const empty: ReadClient = {
    ...emptyPool,
    async readContract(c) {
      if (c.functionName === "getUserAccountData") return [0n, 0n, 0n, 0n, 0n, 2n ** 256n - 1n];
      if (c.functionName === "getUserReserveData") return [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, false];
      return emptyPool.readContract(c);
    },
  };
  const client = venueClient({ [AAVE_VENUE.toLowerCase()]: { ...aaveVenueMirror(2n ** 256n - 1n), debt: () => 0n, collateral: () => 0n }, [MORPHO_VENUE]: morphoVenue() }, registryCbbtcOnMorpho, empty);
  const a = await readAccount(client, OWNER, market, readOpts);
  assert.equal(a.aave?.healthFactor, Number.POSITIVE_INFINITY, "the blind spot: the pool sees nothing");
  assert.ok(a.venues);
  const morpho = a.venues!.venues.find((v) => v.kind === "other")!;
  assert.equal(morpho.venue.toLowerCase(), MORPHO_VENUE);
  assert.equal(morpho.current, true);
  assert.deepEqual(morpho.assets, ["cbBTC"]);
  assert.ok(Math.abs((morpho.healthFactor ?? 0) - 1.72) < 1e-9);
  assert.ok(Math.abs((morpho.debtUsdc ?? 0) - MORPHO_DEBT_USDC) < 1e-9);
  assert.deepEqual(morpho.collateral.map((c) => [c.symbol, c.amount, c.liquidationThresholdBps]), [["cbBTC", 1, 8600]]);
  const aave = a.venues!.venues.find((v) => v.kind === "aave")!;
  assert.equal(aave.current, true, "WETH and cbZEC still point at it");
  assert.deepEqual(aave.assets, ["cbBTC", "WETH", "cbZEC"], "cbBTC keeps the Aave venue as a PREVIOUS venue (M-HIGH-1)");
  assert.ok(Math.abs((a.venues!.healthFactor ?? 0) - 1.72) < 1e-9, "the worst venue's HF");
  assert.ok(Math.abs(a.venues!.otherDebtUsdc - MORPHO_DEBT_USDC) < 1e-9);
  assert.equal(accountHf(a), a.venues!.healthFactor);
  const row = a.collateral.find((c) => c.venueKind === "other")!;
  assert.equal(row.symbol, "cbBTC");
  assert.equal(row.amount, 1);
  assert.equal(row.liquidationThresholdBps, 8600);
  assert.equal(row.venue?.toLowerCase(), MORPHO_VENUE);
});

test("worst venue wins: Aave at 1.95 and Morpho at 1.72 → 1.72; Morpho at 5.0 → the pool's 1.95", async () => {
  const market = await readMarket(fakeClient());
  const low = await readAccount(venueClient({ [AAVE_VENUE.toLowerCase()]: aaveVenueMirror(), [MORPHO_VENUE]: morphoVenue() }, registryCbbtcOnMorpho), OWNER, market, readOpts);
  assert.ok(Math.abs((accountHf(low) ?? 0) - 1.72) < 1e-9);
  // A venue at 5.0 must OWE a debt that implies 5.0 at the app's prices (PX × 0.86 / 5);
  // at the MORPHO_DEBT_USDC that implies 1.72, a claimed 5.0 is a price disagreement and unreadable (residual (b), below).
  const high = await readAccount(venueClient({ [AAVE_VENUE.toLowerCase()]: aaveVenueMirror(), [MORPHO_VENUE]: morphoVenue(5n * WAD, e6((PX * 0.86) / 5)) }, registryCbbtcOnMorpho), OWNER, market, readOpts);
  assert.ok(Math.abs((accountHf(high) ?? 0) - 1.95) < 1e-9);
});

test("N-MED-2 still holds: a venue the registry names that cannot be read → HF null (unreadable), never ∞ and never the other venue's number", async () => {
  const market = await readMarket(fakeClient());
  const registry = { ...registryCbbtcOnMorpho, previousVenues: (asset: string) => (asset === BASE_TOKENS.cbBTC.address.toLowerCase() ? [AAVE_VENUE, DEAD_VENUE] : []) };
  const a = await readAccount(venueClient({ [AAVE_VENUE.toLowerCase()]: aaveVenueMirror(), [MORPHO_VENUE]: morphoVenue() }, registry), OWNER, market, readOpts);
  assert.ok(a.venues);
  const dead = a.venues!.venues.find((v) => v.venue.toLowerCase() === DEAD_VENUE)!;
  assert.equal(dead.readable, false);
  assert.equal(dead.healthFactor, null);
  assert.equal(a.venues!.healthFactor, null);
  assert.match(a.venues!.unreadableReason ?? "", /did not answer/);
  assert.equal(accountHf(a), null, "unreadable — the tile says so and the banner alerts (N-MED-2)");
  assert.ok(a.aave, "the pool leg itself was fine; the page still refuses to show its number alone");
});

test("the Aave venue must agree with the pool: a venue reporting HF 5.0 against a pool at 1.95 is unreadable, not a choice", async () => {
  const market = await readMarket(fakeClient());
  const a = await readAccount(venueClient({ [AAVE_VENUE.toLowerCase()]: aaveVenueMirror(5n * WAD) }, registryAaveOnly), OWNER, market, readOpts);
  assert.equal(accountHf(a), null);
  assert.match(a.venues!.unreadableReason ?? "", /reports HF 5 but the Aave pool reports 1.95/);
  // …and a registry that cannot be read is unreadable too.
  const broken = venueClient({ [AAVE_VENUE.toLowerCase()]: aaveVenueMirror() }, { ...registryAaveOnly, previousVenues: () => { throw new Error("rpc"); } });
  const b = await readAccount(broken, OWNER, market, readOpts);
  assert.equal(accountHf(b), null);
  assert.match(b.venues!.unreadableReason ?? "", /registry unreadable/);
});

test("residual (b), venue optimistic: a Morpho venue claiming HF 2.50 where the app's prices imply 1.72 is unreadable — never healthy, and the reason names the gap", async () => {
  const market = await readMarket(fakeClient());
  // 1 cbBTC against 39,796 USDC at LLTV 86 % implies 1.72 at the cbBTC/USD price the page reads; the venue's BTC/USD oracle says 2.50.
  const a = await readAccount(venueClient({ [AAVE_VENUE.toLowerCase()]: aaveVenueMirror(), [MORPHO_VENUE]: morphoVenue(2_500_000_000_000_000_000n) }, registryCbbtcOnMorpho), OWNER, market, readOpts);
  assert.equal(accountHf(a), null, "unreadable, not 2.50 and not the pool's 1.95");
  const morpho = a.venues!.venues.find((v) => v.kind === "other")!;
  assert.match(morpho.priceDisagreement ?? "", /reports HF 2.50 but the prices this app reads imply at most 1.72 — its oracle values the collateral higher/);
  assert.match(a.venues!.unreadableReason ?? "", /Close that withdraws collateral is refused/);
  const aave = a.venues!.venues.find((v) => v.kind === "aave")!;
  assert.equal(aave.priceDisagreement, null, "the Aave venue is cross-checked against the pool, not against prices");
});

test("residual (b), venue pessimistic: a Morpho venue claiming HF 1.10 where the app's prices imply 1.72 is unreadable the other way round", async () => {
  const market = await readMarket(fakeClient());
  const a = await readAccount(venueClient({ [AAVE_VENUE.toLowerCase()]: aaveVenueMirror(), [MORPHO_VENUE]: morphoVenue(1_100_000_000_000_000_000n) }, registryCbbtcOnMorpho), OWNER, market, readOpts);
  assert.equal(accountHf(a), null);
  const morpho = a.venues!.venues.find((v) => v.kind === "other")!;
  assert.match(morpho.priceDisagreement ?? "", /reports HF 1.10 but the prices this app reads imply at least 1.72 — its oracle values the collateral lower/);
});

test("residual (b): inside the 3 % bound the venue's own number stands (the cbBTC/USD vs BTC/USD basis), and without prices nothing is cross-checked", async () => {
  const market = await readMarket(fakeClient());
  const a = await readAccount(venueClient({ [AAVE_VENUE.toLowerCase()]: aaveVenueMirror(), [MORPHO_VENUE]: morphoVenue(1_700_000_000_000_000_000n) }, registryCbbtcOnMorpho), OWNER, market, readOpts);
  assert.ok(Math.abs((accountHf(a) ?? 0) - 1.7) < 1e-9, "1.70 against an implied 1.72 is inside the bound; it is also the worst venue");
  assert.equal(a.venues!.venues.find((v) => v.kind === "other")!.priceDisagreement, null);
  // readVenueHealth without prices: the venue's word is reported as read, the cross-check is the caller's to ask for.
  const raw = await readVenueHealth(venueClient({ [AAVE_VENUE.toLowerCase()]: aaveVenueMirror(), [MORPHO_VENUE]: morphoVenue(2_500_000_000_000_000_000n) }, registryCbbtcOnMorpho), REGISTRY, ACCOUNT);
  assert.equal(raw.venues.find((v) => v.kind === "other")!.priceDisagreement, null);
  assert.ok(Math.abs((raw.healthFactor ?? 0) - 1.95) < 1e-9);
});

test("slice C: a one-unit USDC residual on the pool and on every venue is NO DEBT — HF ∞ on both legs, the tile's decision from the dust flag, never from a zero", async () => {
  const market = await readMarket(fakeClient());
  // The pool after the fork's repay(max) with exactly the borrow: 1 unit of variable debt, 100 base
  // units of totalDebtBase, a finite and enormous health factor.
  const base = fakeClient();
  const dustPool: ReadClient = {
    ...base,
    async readContract(c) {
      if (c.functionName === "getUserAccountData") return [3_981_544_500_000n, 100n, 0n, 7800n, 7300n, 31_056_047_100_000_000_000_000_000_000n];
      if (c.functionName === "getUserReserveData" && String(c.args?.[0]).toLowerCase() === BASE_TOKENS.USDC.address.toLowerCase()) return [0n, 0n, 1n, 0n, 0n, 0n, 0n, 0n, false];
      return base.readContract(c);
    },
  };
  const hugeHf = 31_056_047_100_000_000_000_000_000_000n;
  const client = venueClient({ [AAVE_VENUE.toLowerCase()]: { ...aaveVenueMirror(hugeHf), debt: () => 1n } }, registryAaveOnly, dustPool);
  const a = await readAccount(client, OWNER, market, readOpts);
  assert.equal(a.aave!.healthFactor, Number.POSITIVE_INFINITY, "the pool leg reads the residual as no debt");
  assert.equal(a.venues!.venues[0].debtIsDust, true);
  assert.equal(a.venues!.venues[0].healthFactor, Number.POSITIVE_INFINITY, "and so does the venue leg, so the two agree");
  assert.equal(a.venues!.healthFactor, Number.POSITIVE_INFINITY);
  assert.equal(a.debtIsDust, true);
  assert.ok(Math.abs(a.debtUsdc - 0.000001) < 1e-12, "the number itself is still reported as read");
  assert.equal(hfBand(accountHf(a)).label, "No debt");

  // A Morpho venue with a unit of rounding contributes nothing to otherDebtUsdc; 101 units is a book.
  const dusty = venueClient({ [AAVE_VENUE.toLowerCase()]: { ...aaveVenueMirror(hugeHf), debt: () => 1n }, [MORPHO_VENUE]: morphoVenue(hugeHf, 1n) }, registryCbbtcOnMorpho, dustPool);
  const d = await readAccount(dusty, OWNER, market, readOpts);
  assert.equal(d.venues!.otherDebtUsdc, 0);
  assert.equal(d.debtIsDust, true);
  const book = venueClient({ [AAVE_VENUE.toLowerCase()]: { ...aaveVenueMirror(hugeHf), debt: () => 1n }, [MORPHO_VENUE]: morphoVenue(5_000_000_000_000_000_000_000n, 101n) }, registryCbbtcOnMorpho, dustPool);
  const b = await readAccount(book, OWNER, market, readOpts);
  assert.equal(b.debtIsDust, false, "101 units on any venue is a debt");
  assert.ok(Math.abs(b.venues!.otherDebtUsdc - 0.000101) < 1e-12);

  // The real position is not dust.
  const real = await readAccount(venueClient({ [AAVE_VENUE.toLowerCase()]: aaveVenueMirror() }, registryAaveOnly), OWNER, market, readOpts);
  assert.equal(real.debtIsDust, false);
  assert.equal(real.aave!.healthFactor < 2, true);
});

test("readVenueHealth alone: no registry pointer for an asset is not an error; a zero-debt venue reads ∞", async () => {
  const client = venueClient({ [AAVE_VENUE.toLowerCase()]: { ...aaveVenueMirror(2n ** 256n - 1n), debt: () => 0n } }, { ...registryAaveOnly, venueOf: (asset: string) => (asset === BASE_TOKENS.cbZEC.address.toLowerCase() ? ZERO : AAVE_VENUE) });
  const v = await readVenueHealth(client, REGISTRY, ACCOUNT);
  assert.equal(v.venues.length, 1);
  assert.deepEqual(v.venues[0].assets, ["cbBTC", "WETH"], "cbZEC is not registered");
  assert.equal(v.healthFactor, Number.POSITIVE_INFINITY);
  assert.equal(v.unreadableReason, null);
});

test("readPendingVenues surfaces a proposed venue replacement and ignores the empty slots", async () => {
  const eta = 1_800_000_000;
  const proposed = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const client = chainClient((c) => {
    if (c.functionName === "venueOf") return AAVE_VENUE;
    if (c.functionName === "pendingVenue") {
      const asset = String(c.args?.[0] ?? "").toLowerCase();
      if (asset === BASE_TOKENS.cbBTC.address.toLowerCase()) return { venue: proposed, priceFeed: "0xcccccccccccccccccccccccccccccccccccccccc", eta: BigInt(eta) };
      return { venue: ZERO, priceFeed: ZERO, eta: 0n };
    }
    throw new Error(`unexpected ${c.functionName}`);
  });
  const rows = await readPendingVenues(client, REGISTRY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].asset, "cbBTC");
  assert.equal(rows[0].proposedVenue, proposed);
  assert.equal(rows[0].currentVenue, AAVE_VENUE);
  assert.equal(rows[0].eta, eta);

  const quiet = chainClient((c) => (c.functionName === "venueOf" ? AAVE_VENUE : { venue: ZERO, priceFeed: ZERO, eta: 0n }));
  assert.deepEqual(await readPendingVenues(quiet, REGISTRY), []);
});

test("readKeeperGrant reads expiry, allowCallback and the period-rolled token budgets", async () => {
  const client = chainClient((c) => {
    switch (c.functionName) {
      case "grantOf":
        assert.equal(c.args?.[2], UNWIND_SELECTOR, "the grant is keyed on the unwind selector, read from the ABI");
        return [true, 0n, 0n, 86_400n, 1_802_592_000n, 1_800_000_000n, true];
      case "grantTokens":
        return [BASE_TOKENS.USDC.address, BASE_TOKENS.AERO.address];
      case "tokenBudgetOf":
        return String(c.args?.[3]).toLowerCase() === BASE_TOKENS.USDC.address.toLowerCase() ? [1_000_000n, 250_000n] : [10n ** 23n, 0n];
      default:
        throw new Error(`unexpected ${c.functionName}`);
    }
  });
  const g = await readKeeperGrant(client, ACCOUNT, KEEPER, ROUTER);
  assert.ok(g);
  assert.equal(g!.active, true);
  assert.equal(g!.allowCallback, true);
  assert.equal(g!.expiry, 1_802_592_000);
  assert.equal(g!.period, 86_400);
  assert.equal(g!.selector, UNWIND_SELECTOR);
  assert.deepEqual(
    g!.tokens.map((t) => [t.symbol, t.amountPerPeriod, t.spent]),
    [
      ["USDC", 1_000_000n, 250_000n],
      ["AERO", 10n ** 23n, 0n],
    ],
  );
  // Unreadable → null, which the UI renders as "nobody is protecting this".
  const dead = chainClient(() => {
    throw new Error("no such account");
  });
  assert.equal(await readKeeperGrant(dead, ACCOUNT, KEEPER, ROUTER), null);
});

// W3-LOW-5 (wave 3): readDirectPositions carries the gauge's early-withdraw penalty window.
test("W3-LOW-5: readDirectPositions reads positionRange, the pool's tick and earlyWithdrawPenalty per id", async () => {
  const { readDirectPositions } = await import("../lib/reads");
  const VENUE = "0x1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d" as const;
  const POOL = "0x0fc47c17af86078d809358db1b4db2debc988566";
  const client = {
    async multicall({ contracts }: { contracts: readonly { address: string; functionName: string; args?: readonly unknown[] }[] }) {
      return contracts.map((c) => {
        if (c.functionName === "POOL") return { status: "success" as const, result: POOL };
        if (c.functionName === "positionRange") return { status: "success" as const, result: [-24_000, -23_600, 123_456n, true] };
        if (c.functionName === "earlyWithdrawPenalty") {
          const id = c.args?.[0] as bigint;
          return { status: "success" as const, result: id === 7n ? [10_000n, 1_789_156_810n] : [0n, 1_789_156_800n] };
        }
        if (c.functionName === "slot0") return { status: "success" as const, result: [24_158_478_068_572_882_064_475_621_010n, -23_756, 0, 1, 1, true] };
        return { status: "failure" as const };
      });
    },
    async readContract() {
      throw new Error("unused");
    },
    async getCode() {
      return "0x";
    },
  };
  const rows = await readDirectPositions(client as never, VENUE, "0x2222222222222222222222222222222222222222", [7n, 9n]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].venue, "direct");
  assert.equal(rows[0].staked, true);
  assert.equal(rows[0].pool?.id, "aero-cbzec-usdc");
  assert.equal(rows[0].inRange, true);
  assert.deepEqual(rows[0].earlyPenalty, { bps: 10_000, until: new Date(1_789_156_810 * 1000).toISOString() });
  assert.equal(rows[1].earlyPenalty, null, "no open window → null");
});
