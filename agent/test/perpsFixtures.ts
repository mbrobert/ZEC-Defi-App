/**
 * Fixtures for the perps keeper tests (BUILD-PLAN Stream D step D4).
 *
 * The SCENE is the Foundry suite's (`contracts/test/HyperliquidPerpVenue.t.sol`): a 5.00 ZEC short against
 * $3,900 of perp balance at the mark read from chain on 2026-09-25 (15,389,417 = $1,538.9417), then the same
 * short at +10 % (the top-up rung), +20 % (de-risk) and +40 % (close). Every number below is the Solidity
 * test's constant, so the keeper's valuation is pinned to what `protect` computes — value for value.
 *
 * `FakeHyperEvm` puts behavioural doubles of the precompiles, the venue and each account on `MockChain`, so
 * the reader, dispatcher and monitor run through REAL viem encoding and decoding, and a simulated
 * `execAsKeeper(protect)` reverts with the venue's own error names, ABI-encoded, exactly as chain 999 would.
 */
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeFunctionResult, getAddress, keccak256, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { HYPERCORE_PRECOMPILES, PERP_RUNG_INDEX, entryDistanceBpsForMarginBps, equivalentHfBps, perpLadderFor, shortDistanceBps, type HfRungId } from "@zyo/shared";
import { hyperliquidPerpVenueAbi, oilskinAccountAbi, PERP_GRANT_SELECTORS } from "../src/abi/oilskin.js";
import { perpKeeperExecAbi } from "../src/perps/dispatcher.js";
import type { PerpsEntry, PerpsSnapshot, PerpsVenueParams } from "../src/perps/reader.js";
import type { Address } from "../src/types/evm.js";
import { MockChain } from "./mockChain.js";
import { accountCreatedEvent } from "../src/abi/oilskin.js";

// ---- the venue as read (research JSON 2026-09-25) and the Foundry scene ------------------------------------

export const ZEC = 214;
export const SZ_DEC = 2;
export const MAX_LEV = 10;
export const MMR = 500;
export const MARK = 15_389_417n; // 1538.9417
export const ORACLE = 15_387_700n;
export const SZ = 500n; // 5.00 ZEC
export const NTL = 7_694_708_500n;
export const A0 = 3_900_000_000n;
export const D0 = 4350;
export const HF0 = 17699;
export const RESERVE0 = 348_979_462n;
export const MARK_10 = 16_928_359n;
export const A_10 = 3_130_529_000n;
export const NTL_10 = 8_464_179_500n;
export const MARK_20 = 18_467_300n;
export const A_20 = 2_361_058_500n;
export const NTL_20 = 9_233_650_000n;
export const MARK_40 = 21_545_184n;
export const A_40 = 822_116_500n;
export const NTL_40 = 10_772_592_000n;
/** The Foundry scene's oracle: the mark less 1,717 raw. */
export const sceneOracle = (mark: bigint): bigint => mark - 1_717n;

export const VENUE = getAddress("0x5e00000000000000000000000000000000000001") as Address;
export const PERPS_FACTORY = getAddress("0x5e000000000000000000000000000000000000fa") as Address;
export const PERP_ACCOUNT_A = getAddress("0x5eac000000000000000000000000000000000001") as Address;
export const PERP_ACCOUNT_B = getAddress("0x5eac000000000000000000000000000000000002") as Address;
export const PERP_OWNER_A = getAddress("0x5e0a000000000000000000000000000000000001") as Address;
export const PERP_OWNER_B = getAddress("0x5e0a000000000000000000000000000000000002") as Address;
export const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** The venue's immutables as the Foundry suite deploys them: floor L = 2 (5,000 bps), $25,000 cap, 5 % deviation, 1× reserve. */
export const PARAMS: PerpsVenueParams = {
  venue: VENUE.toLowerCase() as Address,
  perpAsset: ZEC,
  szDecimals: SZ_DEC,
  maxLeverage: MAX_LEV,
  mmrBps: MMR,
  usdcTokenIndex: 0,
  usdcWeiDecimals: 8,
  usdcEvmDecimals: 6,
  maxMarkOracleDeviationBps: 500,
  minEntryDistanceBps: entryDistanceBpsForMarginBps(5_000, MMR),
  maxNotionalE6: 25_000_000_000n,
  defaultReserveMultipleBps: 10_000,
};

/** The entry the scene's `open` records: D0 / HF0 / SZ / RESERVE0. */
export const ENTRY0: PerpsEntry = { distanceBps: D0, hfBps: HF0, sz: SZ, reserveE6: RESERVE0, at: 1_789_000_000 };

/** USDC 10^6 → the spot precompile's weiDecimals (10^8). */
export const e6ToWei = (e6: bigint): bigint => e6 * 100n;

export interface SceneOpts {
  mark?: bigint;
  oracle?: bigint;
  a?: bigint;
  ntl?: bigint;
  szi?: bigint;
  spotE6?: bigint;
  withdrawableE6?: bigint;
  entry?: PerpsEntry | null;
  independentMark?: bigint | null;
  independentAtS?: number;
  nowS?: bigint;
  isolated?: boolean;
  leverage?: number;
  assetInfo?: Partial<{ szDecimals: number; maxLeverage: number; onlyIsolated: boolean }>;
  readFailures?: { what: string; reason: string }[];
  missing?: ("position" | "summary" | "markRaw" | "spot")[];
}

/** A snapshot the valuation can judge, straight from the scene's numbers (no chain). */
export function sceneSnapshot(o: SceneOpts = {}): PerpsSnapshot {
  const mark = o.mark ?? MARK;
  const szi = o.szi ?? -SZ;
  const a = o.a ?? A0;
  const ntl = o.ntl ?? (szi < 0n ? -szi * mark : 0n);
  const nowS = o.nowS ?? 1_789_000_100n;
  const missing = new Set(o.missing ?? []);
  return {
    blockNumber: 46_887_687n,
    nowS,
    params: PARAMS,
    position: missing.has("position") ? null : { szi, entryNtl: szi < 0n ? -szi * MARK : 0n, isolatedRawUsd: 0n, leverage: o.leverage ?? MAX_LEV, isIsolated: o.isolated ?? false },
    spot: missing.has("spot") ? null : { total: e6ToWei(o.spotE6 ?? RESERVE0), hold: 0n, entryNtl: 0n },
    withdrawableE6: o.withdrawableE6 ?? a,
    markRaw: missing.has("markRaw") ? null : mark,
    oracleRaw: o.oracle ?? sceneOracle(mark),
    assetInfo: { coin: "ZEC", marginTableId: 52, szDecimals: SZ_DEC, maxLeverage: MAX_LEV, onlyIsolated: false, ...(o.assetInfo ?? {}) },
    summary: missing.has("summary") ? null : { accountValue: a, marginUsed: ntl / 10n, ntlPos: ntl, rawUsd: a },
    entry: o.entry === undefined ? ENTRY0 : o.entry,
    independent: o.independentMark === null ? null : { markRaw: o.independentMark ?? mark, atS: o.independentAtS ?? Number(nowS), source: "test" },
    readFailures: o.readFailures ?? [],
  };
}

/** The scene's distance and equivalent HF for any (mark, account value), by the shared rule. */
export function sceneHealth(mark: bigint, a: bigint, szi = -SZ): { distanceBps: number; hfBps: number } {
  const distanceBps = shortDistanceBps({ accountValueE6: a, szi, markRaw: mark, szDecimals: SZ_DEC, mmrBps: MMR });
  return { distanceBps, hfBps: equivalentHfBps(distanceBps) };
}

/** The scene account's own ladder (from ENTRY0), as the venue derives it. */
export const LADDER0 = perpLadderFor(D0);
export const rung0 = (id: HfRungId) => LADDER0[PERP_RUNG_INDEX[id]]!;

// ---- the behavioural HyperEVM fake ------------------------------------------------------------------------

export interface FakePermission {
  keeper: Address;
  active: boolean;
  allowCallback: boolean;
  expiry: number;
  period: number;
  periodStart: number;
}

export interface FakePerpGrant {
  keeper: Address;
  expiry: number;
  period: number;
  periodStart: number;
  allowedRungs: number;
  topUpUsdcPerPeriod: bigint;
  reduceSzPerPeriod: bigint;
  maxSlippageBps: number;
  topUpSpent: bigint;
  reduceSpent: bigint;
  epoch: bigint;
}

export interface FakePerpAccount {
  owner: Address;
  szi: bigint;
  accountValueE6: bigint;
  /** Spot reserve in 10^6 (served in weiDecimals). */
  spotE6: bigint;
  withdrawableE6: bigint;
  /** When set, `accountMarginSummary.ntlPos` answers this instead of the short's own notional. */
  ntlPosOverride?: bigint;
  entry: PerpsEntry | null;
  permission: FakePermission | null;
  grant: FakePerpGrant | null;
  epoch: bigint;
  isolated?: boolean;
  /** A scripted revert for the next simulated / sent `protect`, by the venue's error name. */
  revertNext?: { name: string; args: readonly unknown[] } | null;
}

export interface PendingAction {
  account: Address;
  rung: number;
  topUpE6: bigint;
  reduceSz: bigint;
  atBlock: bigint;
  hash: Hex;
}

export interface FakeAssetInfo {
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
}

/**
 * HyperEVM as the keeper sees it: the precompiles answer from `accounts` and `mark`; the venue answers its
 * immutables and per-account records; each account answers `grantOf` / `grantEpoch` and runs a faithful
 * miniature of `protect` on `execAsKeeper` — the same checks in the same order, reverting with the venue's
 * names — both for `eth_call` (the dispatcher's simulation) and for a signed raw transaction (which also
 * charges the grant's budgets and queues the CoreWriter action). The action LANDS only when the test says so
 * (`land`), after however many blocks it advances: that is the delay the dispatcher's `confirm` is written for.
 */
export class FakeHyperEvm {
  readonly chain: MockChain;
  mark = MARK;
  oracle = sceneOracle(MARK);
  assetInfo: FakeAssetInfo = { szDecimals: SZ_DEC, maxLeverage: MAX_LEV, onlyIsolated: false };
  accounts = new Map<string, FakePerpAccount>();
  failing = new Set<string>();
  pending: PendingAction[] = [];
  sent: { from: Address; to: Address; rung: number; topUpE6: bigint; reduceSz: bigint; nonce: number | undefined; hash: Hex }[] = [];
  /** Actions that reverted on send (a receipt with status 0). */
  reverted: { hash: Hex; name: string }[] = [];

  constructor() {
    this.chain = new MockChain({ pool: ZERO, dataProvider: ZERO, oracle: ZERO, factory: PERPS_FACTORY }, accountCreatedEvent);
    this.chain.chainId = 999;
    this.chain.blockNumber = 46_887_687n;
    this.chain.nowS = 1_789_000_100n;
    const c = this.chain.contracts;
    for (const [name, addr] of Object.entries(HYPERCORE_PRECOMPILES)) c.set(addr.toLowerCase(), (data) => this.precompile(name, addr as Address, data));
    c.set(VENUE.toLowerCase(), (data) => this.venueCall(data));
    this.chain.onSendRawTransaction = async (raw) => this.rawTx(raw);
  }

  get nowS(): bigint {
    return this.chain.nowS;
  }

  advance(blocks = 1n, seconds = 1n): void {
    this.chain.blockNumber += blocks;
    this.chain.nowS += seconds;
  }

  /** Register an account with the scene's short (or the override), an entry, a live grant for `keeper`. */
  addAccount(account: Address, owner: Address, keeper: Address | null, over: Partial<FakePerpAccount> = {}, opts: { emit?: boolean; block?: bigint } = {}): FakePerpAccount {
    const now = Number(this.chain.nowS);
    const rec: FakePerpAccount = {
      owner,
      szi: -SZ,
      accountValueE6: A0,
      spotE6: RESERVE0,
      withdrawableE6: A0,
      entry: { ...ENTRY0 },
      epoch: 0n,
      permission: keeper ? { keeper: keeper.toLowerCase() as Address, active: true, allowCallback: true, expiry: now + 30 * 86_400, period: 86_400, periodStart: now } : null,
      grant: keeper ? { keeper: keeper.toLowerCase() as Address, expiry: now + 30 * 86_400, period: 86_400, periodStart: now, allowedRungs: 0b1110, topUpUsdcPerPeriod: 10_000_000_000n, reduceSzPerPeriod: 500n, maxSlippageBps: 50, topUpSpent: 0n, reduceSpent: 0n, epoch: 0n } : null,
      ...over,
    };
    this.accounts.set(account.toLowerCase(), rec);
    this.chain.contracts.set(account.toLowerCase(), (data, from) => this.accountCall(account, data, from, false));
    if (opts.emit !== false) this.chain.emitAccountCreated(owner, account, opts.block ?? this.chain.blockNumber);
    return rec;
  }

  /** The scene at +10 % / +20 % / +40 %: mark, account value and (implicitly) the summary's notional. */
  scene(account: Address, which: 0 | 10 | 20 | 40): void {
    const a = this.accounts.get(account.toLowerCase())!;
    const [mark, av] = which === 0 ? [MARK, A0] : which === 10 ? [MARK_10, A_10] : which === 20 ? [MARK_20, A_20] : [MARK_40, A_40];
    this.mark = mark;
    this.oracle = sceneOracle(mark);
    a.accountValueE6 = av;
  }

  health(account: Address): { distanceBps: number; hfBps: number } {
    const a = this.accounts.get(account.toLowerCase())!;
    return sceneHealth(this.mark, a.accountValueE6, a.szi);
  }

  /** Let a queued CoreWriter action land (or not): the reduce fills `fill` of what was asked, the top-up moves. */
  land(opts: { fill?: "all" | "none" | bigint; topUp?: boolean } = {}): PendingAction[] {
    const done = this.pending.splice(0);
    for (const p of done) {
      const a = this.accounts.get(p.account.toLowerCase())!;
      const fill = opts.fill === undefined || opts.fill === "all" ? p.reduceSz : opts.fill === "none" ? 0n : opts.fill;
      if (opts.topUp !== false && p.topUpE6 > 0n) {
        a.spotE6 -= p.topUpE6;
        a.accountValueE6 += p.topUpE6;
      }
      if (fill > 0n) a.szi += fill; // a short: size shrinks towards zero
    }
    return done;
  }

  // ---- precompiles ------------------------------------------------------------------------------------------

  private precompile(name: string, addr: Address, data: Hex): Hex {
    if (this.failing.has(name)) throw Object.assign(new Error("execution reverted"), { code: 3 });
    switch (name) {
      case "position": {
        const [user] = decodeAbiParameters([{ type: "address" }, { type: "uint16" }], data);
        const a = this.accounts.get(user.toLowerCase());
        const szi = a?.szi ?? 0n;
        return encodeAbiParameters([{ type: "int64" }, { type: "uint64" }, { type: "int64" }, { type: "uint32" }, { type: "bool" }], [szi, szi < 0n ? -szi * MARK : 0n, 0n, MAX_LEV, a?.isolated ?? false]);
      }
      case "spotBalance": {
        const [user] = decodeAbiParameters([{ type: "address" }, { type: "uint64" }], data);
        const a = this.accounts.get(user.toLowerCase());
        return encodeAbiParameters([{ type: "uint64" }, { type: "uint64" }, { type: "uint64" }], [e6ToWei(a?.spotE6 ?? 0n), 0n, 0n]);
      }
      case "withdrawable": {
        const [user] = decodeAbiParameters([{ type: "address" }], data);
        return encodeAbiParameters([{ type: "uint64" }], [this.accounts.get(user.toLowerCase())?.withdrawableE6 ?? 0n]);
      }
      case "markPx":
        return encodeAbiParameters([{ type: "uint64" }], [this.mark]);
      case "oraclePx":
        return encodeAbiParameters([{ type: "uint64" }], [this.oracle]);
      case "perpAssetInfo":
        return encodeAbiParameters([{ type: "tuple", components: [{ type: "string" }, { type: "uint32" }, { type: "uint8" }, { type: "uint8" }, { type: "bool" }] }], [["ZEC", 52, this.assetInfo.szDecimals, this.assetInfo.maxLeverage, this.assetInfo.onlyIsolated]]);
      case "accountMarginSummary": {
        const [, user] = decodeAbiParameters([{ type: "uint32" }, { type: "address" }], data);
        const a = this.accounts.get(user.toLowerCase());
        const ntl = a ? (a.ntlPosOverride ?? (a.szi < 0n ? -a.szi * this.mark : 0n)) : 0n;
        return encodeAbiParameters([{ type: "int64" }, { type: "uint64" }, { type: "uint64" }, { type: "int64" }], [a?.accountValueE6 ?? 0n, ntl / 10n, ntl, a?.accountValueE6 ?? 0n]);
      }
      default:
        throw Object.assign(new Error(`fake precompile ${name} (${addr}) not scripted`), { code: 3 });
    }
  }

  // ---- the venue --------------------------------------------------------------------------------------------

  private venueCall(data: Hex): Hex {
    const { functionName, args } = decodeFunctionData({ abi: hyperliquidPerpVenueAbi, data });
    const res = (result: unknown) => encodeFunctionResult({ abi: hyperliquidPerpVenueAbi, functionName, result } as never);
    switch (functionName) {
      case "PERP_ASSET":
        return res(PARAMS.perpAsset);
      case "SZ_DECIMALS":
        return res(PARAMS.szDecimals);
      case "MAX_LEVERAGE":
        return res(PARAMS.maxLeverage);
      case "USDC_TOKEN_INDEX":
        return res(BigInt(PARAMS.usdcTokenIndex));
      case "USDC_WEI_DECIMALS":
        return res(PARAMS.usdcWeiDecimals);
      case "USDC_EVM_DECIMALS":
        return res(PARAMS.usdcEvmDecimals);
      case "MAX_MARK_ORACLE_DEVIATION_BPS":
        return res(BigInt(PARAMS.maxMarkOracleDeviationBps));
      case "MIN_ENTRY_MARGIN_BPS":
        return res(5_000n);
      case "MAX_NOTIONAL_E6":
        return res(PARAMS.maxNotionalE6);
      case "DEFAULT_RESERVE_MULTIPLE_BPS":
        return res(BigInt(PARAMS.defaultReserveMultipleBps));
      case "mmrBps":
        return res(BigInt(MMR));
      case "minEntryDistanceBps":
        return res(BigInt(PARAMS.minEntryDistanceBps));
      case "entryOf": {
        const a = this.accounts.get((args as [Address])[0].toLowerCase());
        const e = a?.entry;
        return res(e ? [e.distanceBps, e.hfBps, e.sz, e.reserveE6, BigInt(e.at)] : [0, 0, 0n, 0n, 0n]);
      }
      case "perpGrantOf": {
        const a = this.accounts.get((args as [Address])[0].toLowerCase());
        const g = a?.grant;
        return res(
          g
            ? { keeper: g.keeper, expiry: BigInt(g.expiry), period: BigInt(g.period), periodStart: BigInt(g.periodStart), allowedRungs: g.allowedRungs, topUpUsdcPerPeriod: g.topUpUsdcPerPeriod, reduceSzPerPeriod: g.reduceSzPerPeriod, maxSlippageBps: g.maxSlippageBps, topUpSpent: g.topUpSpent, reduceSpent: g.reduceSpent, epoch: g.epoch }
            : { keeper: ZERO, expiry: 0n, period: 0n, periodStart: 0n, allowedRungs: 0, topUpUsdcPerPeriod: 0n, reduceSzPerPeriod: 0n, maxSlippageBps: 0, topUpSpent: 0n, reduceSpent: 0n, epoch: 0n }
        );
      }
      case "reserveMultipleBps":
        return res(0n);
      case "baseRecipient":
        return res("0x" + "00".repeat(32));
      default:
        throw Object.assign(new Error(`fake venue: ${functionName} not scripted`), { code: 3 });
    }
  }

  // ---- the account ------------------------------------------------------------------------------------------

  private revert(name: string, args: readonly unknown[] = []): never {
    throw Object.assign(new Error("execution reverted"), { code: 3, data: encodeErrorResult({ abi: perpKeeperExecAbi, errorName: name, args } as never) });
  }

  private accountCall(account: Address, data: Hex, from: Address | undefined, send: boolean): Hex {
    const a = this.accounts.get(account.toLowerCase())!;
    const { functionName, args } = decodeFunctionData({ abi: perpKeeperExecAbi, data });
    if (functionName === "grantOf") {
      const p = a.permission;
      const [keeper, target, selector] = args as [Address, Address, Hex];
      const matches = p && keeper.toLowerCase() === p.keeper && target.toLowerCase() === VENUE.toLowerCase() && selector === PERP_GRANT_SELECTORS["HyperliquidPerpVenue.protect"];
      return encodeFunctionResult({
        abi: oilskinAccountAbi,
        functionName: "grantOf",
        result: matches ? [p!.active, 0n, 0n, p!.period, p!.expiry, p!.periodStart, p!.allowCallback] : [false, 0n, 0n, 0, 0, 0, false],
      });
    }
    if (functionName === "grantEpoch") return encodeFunctionResult({ abi: oilskinAccountAbi, functionName: "grantEpoch", result: a.epoch });
    if (functionName === "owner") return encodeFunctionResult({ abi: oilskinAccountAbi, functionName: "owner", result: a.owner });
    if (functionName !== "execAsKeeper") throw Object.assign(new Error(`fake account: ${functionName} not scripted`), { code: 3 });

    const [calls] = args as [readonly { target: Address; value: bigint; data: Hex; callback: boolean }[]];
    const keeper = (from ?? ZERO).toLowerCase() as Address;
    const now = Number(this.chain.nowS);
    // the account's own Permission check
    const p = a.permission;
    if (!p || !p.active || p.expiry <= now || keeper !== p.keeper) this.revert("NotGranted", [keeper, VENUE, PERP_GRANT_SELECTORS["HyperliquidPerpVenue.protect"]]);
    if (calls.length !== 1 || calls[0]!.target.toLowerCase() !== VENUE.toLowerCase()) this.revert("NotGranted", [keeper, calls[0]?.target ?? ZERO, "0x00000000"]);
    if (!p.allowCallback) this.revert("NotActivePeripheral");
    const inner = decodeFunctionData({ abi: hyperliquidPerpVenueAbi, data: calls[0]!.data });
    if (inner.functionName !== "protect") this.revert("NotGranted", [keeper, VENUE, calls[0]!.data.slice(0, 10)]);
    const [rung, topUpE6, reduceSz] = inner.args as [number, bigint, bigint];
    if (a.revertNext) {
      const r = a.revertNext;
      if (send) a.revertNext = null;
      this.revert(r.name, r.args);
    }
    // the venue's protect, in miniature and in order
    const g = a.grant;
    if (!g || g.keeper !== keeper) this.revert("NotGrantedKeeper", [keeper]);
    if (now >= g.expiry) this.revert("GrantExpired", [g.expiry]);
    if (g.epoch !== a.epoch) this.revert("GrantEpochStale", [g.epoch, a.epoch]);
    if (rung < 1 || rung > 3 || ((g.allowedRungs >> rung) & 1) === 0) this.revert("RungNotAllowed", [rung]);
    if (topUpE6 === 0n && reduceSz === 0n) this.revert("NothingToDo");
    if (rung === 1 && reduceSz !== 0n) this.revert("ReduceNotAllowedAtRung", [rung]);
    if (!a.entry) this.revert("NoEntry");
    if (a.szi === 0n) this.revert("NoPosition");
    const h = sceneHealth(this.mark, a.accountValueE6, a.szi);
    const ladder = perpLadderFor(a.entry.distanceBps);
    if (h.hfBps >= ladder[rung]!.hfBps) this.revert("RungNotCrossed", [rung, h.hfBps, ladder[rung]!.hfBps]);
    const rolled = now >= g.periodStart + g.period;
    const topUpSpent = rolled ? 0n : g.topUpSpent;
    const reduceSpent = rolled ? 0n : g.reduceSpent;
    if (topUpE6 !== 0n) {
      const remaining = g.topUpUsdcPerPeriod - (topUpSpent < g.topUpUsdcPerPeriod ? topUpSpent : g.topUpUsdcPerPeriod);
      if (topUpE6 > remaining) this.revert("TopUpBudgetExceeded", [topUpE6, remaining]);
      if (a.spotE6 < topUpE6) this.revert("ReserveShort", [a.spotE6, topUpE6]);
    }
    if (reduceSz !== 0n) {
      const remaining = g.reduceSzPerPeriod - (reduceSpent < g.reduceSzPerPeriod ? reduceSpent : g.reduceSzPerPeriod);
      if (reduceSz > remaining) this.revert("ReduceBudgetExceeded", [reduceSz, remaining]);
      if (reduceSz > -a.szi) this.revert("ReduceExceedsPosition", [reduceSz, -a.szi]);
    }
    if (send) {
      if (rolled) {
        g.periodStart = now;
        g.topUpSpent = 0n;
        g.reduceSpent = 0n;
      }
      g.topUpSpent += topUpE6;
      g.reduceSpent += reduceSz;
    }
    return encodeFunctionResult({ abi: oilskinAccountAbi, functionName: "execAsKeeper", result: ["0x"] });
  }

  private async rawTx(raw: Hex): Promise<Hex> {
    const tx = parseTransaction(raw);
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })) as Address;
    const hash = keccak256(raw);
    const to = (tx.to ?? ZERO) as Address;
    let status: "0x1" | "0x0" = "0x1";
    let decoded: { rung: number; topUpE6: bigint; reduceSz: bigint } | null = null;
    try {
      const { args } = decodeFunctionData({ abi: perpKeeperExecAbi, data: tx.data as Hex });
      const [calls] = args as unknown as [readonly { data: Hex }[]];
      const inner = decodeFunctionData({ abi: hyperliquidPerpVenueAbi, data: calls[0]!.data });
      const [rung, topUpE6, reduceSz] = inner.args as [number, bigint, bigint];
      decoded = { rung, topUpE6, reduceSz };
      this.accountCall(to, tx.data as Hex, from, true);
      this.pending.push({ account: to, rung, topUpE6, reduceSz, atBlock: this.chain.blockNumber, hash });
    } catch (e) {
      status = "0x0";
      this.reverted.push({ hash, name: e instanceof Error ? e.message : String(e) });
    }
    this.sent.push({ from, to, rung: decoded?.rung ?? -1, topUpE6: decoded?.topUpE6 ?? 0n, reduceSz: decoded?.reduceSz ?? 0n, nonce: tx.nonce, hash });
    this.chain.receipts.set(hash.toLowerCase(), { status, blockNumber: this.chain.blockNumber });
    this.chain.txCount.set(from.toLowerCase(), (this.chain.txCount.get(from.toLowerCase()) ?? 0) + 1);
    return hash;
  }
}
