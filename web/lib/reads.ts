/**
 * Chain reads (viem). The dashboard and the wizard read Aave reserve
 * parameters, oracle prices, the connected wallet's OilskinAccount and its
 * positions FROM CHAIN. The indexer is only a cache the UI paints from
 * while these resolve (see lib/indexer.ts).
 *
 * An account's health is read VENUE-AWARE (audit wave 2, M-HIGH-2): the registry names, per
 * collateral asset, the venue it currently points at and every venue it pointed at before, and each
 * of those is asked `ICollateralVenue.{healthFactor, debt, collateral, liquidationThresholdBps}`
 * for the account. The Aave pool is still read directly (`getUserAccountData`, per-reserve rows) and
 * the Aave venue's answer must agree with it; the health factor shown is the WORST venue's, and it
 * is `null` — "unreadable", never "no debt" — whenever any venue could not be read (N-MED-2).
 *
 * Reads are batched through viem `multicall` (Multicall3 from viem's `base`
 * chain definition) and fall back to one eth_call per item if the batch
 * itself fails, so a missing/reverting multicall never blanks the page.
 */
import { BaseError, ContractFunctionRevertedError, type Address, type Hex } from "viem";
import { COLLATERAL_SYMBOLS, describeLpEnumerationFault, isLoanDust, isZeroAddress, type CollateralSymbol } from "@zyo/shared";
import { AAVE_V3, BASE_TOKENS, COLLATERAL_ASSETS } from "./chain";
import { AAVE_ORACLE_ABI, ERC20_ABI, POOL_ABI, POOL_DATA_PROVIDER_ABI } from "./abi/aave";
import { AAVE_VENUE_ABI, ACCOUNT_ABI, AERODROME_CLPOOL_ABI, COLLATERAL_REGISTRY_ABI, COLLATERAL_VENUE_ABI, DIRECT_LP_VENUE_ABI, FACTORY_ABI, LP_VENUE_ABI, ROUTER_ABI, SNUGGLE_VAULT_ABI } from "./abi/oilskin";
import { baseUnitsToUsd, fromAtomic, rayToAprPct, wadHealthFactor } from "./math";
import type { KeeperGrantRead } from "./keeper";
import { UNWIND_SELECTOR, type Deployment } from "./plan";
import { isInRange } from "./tickmath";
import { CURATED_POOLS, PERMIT2, directPoolId, type CuratedPool } from "@zyo/shared";

/**
 * The subset of a viem PublicClient the readers need. Structural, so wagmi's
 * chain-specialised client (Base has OP-stack "deposit" tx formatters that
 * make the full PublicClient type invariant) is accepted without casts.
 */
export type ReadClient = {
  multicall: (args: { contracts: readonly unknown[]; allowFailure: true }) => Promise<{ status: "success" | "failure"; result?: unknown }[]>;
  readContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => Promise<unknown>;
  getCode: (args: { address: Address }) => Promise<`0x${string}` | undefined>;
};

export type ReadSource = "live" | "snapshot";

export interface ReserveParams {
  symbol: CollateralSymbol | "USDC";
  liquidationThresholdBps: number;
  ltvBps: number;
  liquidationBonusBps: number;
  usageAsCollateralEnabled: boolean;
  borrowingEnabled: boolean;
  isActive: boolean;
  isFrozen: boolean;
  variableBorrowAprPct: number;
  supplyAprPct: number;
  /** Aave oracle price, USD. */
  priceUsd: number;
}

export interface MarketRead {
  reserves: Record<CollateralSymbol | "USDC", ReserveParams | null>;
  usdcBorrowAprPct: number;
  readAt: string;
  source: ReadSource;
}

export interface CollateralHolding {
  symbol: CollateralSymbol;
  amountAtomic: bigint;
  amount: number;
  usd: number;
  /** The venue holding it; absent for the Aave pool rows read before the venue-aware read existed. */
  venue?: Address;
  venueKind?: VenueKind;
  /** The venue's live liquidation threshold for this asset (Morpho: its LLTV). Absent for Aave rows — the market read carries it. */
  liquidationThresholdBps?: number;
}

/** "aave" = an AaveV3Venue over the Aave provider in `@zyo/shared`, i.e. the pool the `aave` leg of an account read describes. */
export type VenueKind = "aave" | "other";

/** One venue the registry names for the account's collateral, read through `ICollateralVenue`. */
export interface VenueHealthRead {
  venue: Address;
  kind: VenueKind;
  /** Collateral symbols the registry routes to this venue, now or before. */
  assets: CollateralSymbol[];
  /** True when at least one asset's CURRENT pointer is this venue (else it is only a previous venue). */
  current: boolean;
  /** `healthFactor(account)`: ∞ = no debt on this venue; null = unreadable. */
  healthFactor: number | null;
  /** `debt(account, USDC)`, human units; null = unreadable. */
  debtUsdc: number | null;
  /** True when `debtUsdc` is at or below the shared LOAN_DUST_UNITS: rounding, shown as no debt (slice C). */
  debtIsDust: boolean;
  /** `collateral(account, asset)` + `liquidationThresholdBps(asset)` per ENABLED asset routed here. */
  collateral: { symbol: CollateralSymbol; amountAtomic: bigint; amount: number; liquidationThresholdBps: number | null }[];
  /** Every word above decoded. A venue that is not readable makes the whole account unreadable. */
  readable: boolean;
  /**
   * Set when the venue's own health factor disagrees, beyond VENUE_PRICE_DISAGREEMENT_TOLERANCE,
   * with the one the prices this app reads imply from the venue's collateral, debt and thresholds
   * (RISKS §8 residual (b), policy 2026-09-10). The account is then unreadable — never healthy —
   * and a Close that would withdraw collateral is refused with this reason.
   */
  priceDisagreement: string | null;
}

/**
 * The keeper's ORACLE_DEVIATION_BPS default is 300 (agent/src/config.ts, 3 %): the bound inside
 * which a venue's own health factor must agree with the one the keeper's Chainlink feeds imply.
 * The page applies the same bound with the Aave-oracle prices it already reads — for cbBTC that is
 * the cbBTC/USD feed the keeper uses, while Morpho's cbBTC market prices with BTC/USD, so a cbBTC
 * depeg is exactly what this catches. A single collateral asset makes the implied band a point; a
 * multi-market venue may sit anywhere between its worst market and the aggregate.
 */
export const VENUE_PRICE_DISAGREEMENT_TOLERANCE = 0.03;

/** Prices the page cross-checks a venue's health factor against: USD per unit, from the Aave oracle. */
export interface VenuePrices {
  collateral: Partial<Record<CollateralSymbol, number>>;
  usdc: number;
}

function priceDisagreementOf(v: VenueHealthRead, prices: VenuePrices): string | null {
  if (v.kind !== "other" || !v.readable || v.healthFactor === null || v.debtUsdc === null || !(v.debtUsdc > 0)) return null;
  const tag = `venue ${v.venue.slice(0, 6)}…${v.venue.slice(-4)}`;
  const debtUsd = v.debtUsdc * prices.usdc;
  if (!Number.isFinite(debtUsd) || !(debtUsd > 0)) return `${tag}: no USDC price to cross-check its health factor against`;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const c of v.collateral) {
    if (c.amountAtomic === 0n || c.liquidationThresholdBps === null) continue;
    const price = prices.collateral[c.symbol];
    if (typeof price !== "number" || !Number.isFinite(price) || !(price > 0)) return `${tag}: no ${c.symbol} price to cross-check its health factor against`;
    const a = c.amount * price * (c.liquidationThresholdBps / 10_000);
    sum += a;
    min = Math.min(min, a);
  }
  if (!(sum > 0)) return null; // debt with no valued collateral: nothing to compare here (the keeper escalates it)
  const ceiling = sum / debtUsd;
  const floor = min / debtUsd;
  const hf = v.healthFactor;
  if (hf > ceiling * (1 + VENUE_PRICE_DISAGREEMENT_TOLERANCE)) {
    return `${tag} reports HF ${hf.toFixed(2)} but the prices this app reads imply at most ${ceiling.toFixed(2)} — its oracle values the collateral higher; unreadable, and a Close that withdraws collateral is refused until they agree`;
  }
  if (hf < floor * (1 - VENUE_PRICE_DISAGREEMENT_TOLERANCE)) {
    return `${tag} reports HF ${hf.toFixed(2)} but the prices this app reads imply at least ${floor.toFixed(2)} — its oracle values the collateral lower; unreadable, and a Close that withdraws collateral is refused until they agree`;
  }
  return null;
}

export interface VenueHealth {
  registry: Address;
  venues: VenueHealthRead[];
  /**
   * The WORST health factor across every venue (∞ when no venue carries debt). `null` when the
   * registry or any venue could not be read, or when the Aave venue's answer does not agree with the
   * pool read — "unreadable", which the dashboard shows as a warning, never as "No debt" (N-MED-2).
   */
  healthFactor: number | null;
  /** Σ `debt(account, USDC)` over venues that are NOT the Aave pool, human units (the pool's own debt is in `aave`). */
  otherDebtUsdc: number;
  /** Why `healthFactor` is null, when it is. */
  unreadableReason: string | null;
}

/** One engine position as read from chain (ISnuggleVault.positions + the pool's slot0). */
export interface LpPositionRead {
  positionId: bigint;
  /** The LP pool id: the engine's bytes32, or the pool address left-padded on the direct venue. */
  enginePoolId: `0x${string}`;
  pool: CuratedPool | undefined;
  /** Which venue holds it (2026-09-11): the engine, or Oilskin's direct Slipstream venue. */
  venue: "engine" | "direct";
  /** Direct venue only: whether the NFT is staked in the pool's gauge (earning AERO). */
  staked?: boolean;
  rangeWidthBps: number;
  tickLower: number;
  tickUpper: number;
  /** Pool's current tick (null if the pool could not be read). */
  tick: number | null;
  inRange: boolean | null;
  rebalanceDelayHours: number;
  autoCompound: boolean;
  openedAt: string | null;
  /** Lifetime AERO paid to this position, base units (18 dp). */
  cumulativeRewardsAtomic: bigint;
  totalRebalances: number;
}

export interface AccountRead {
  owner: Address;
  /** Predicted (CREATE2) or deployed account address; null when the factory is not configured. */
  account: Address | null;
  deployed: boolean;
  /** The Aave pool read directly (`getUserAccountData`); null when that leg failed. */
  aave: {
    totalCollateralUsd: number;
    totalDebtUsd: number;
    availableBorrowsUsd: number;
    currentLiquidationThresholdBps: number;
    ltvBps: number;
    healthFactor: number;
  } | null;
  /**
   * Every venue the registry names for the account's collateral, read through `ICollateralVenue`
   * (audit wave 2, M-HIGH-2). `null` when no registry was given (the deployment is unknown), in
   * which case the page falls back to the Aave leg alone.
   */
  venues: VenueHealth | null;
  /** Collateral under the account: the Aave pool's rows, plus one row per non-Aave venue holding. */
  collateral: CollateralHolding[];
  debtUsdc: number;
  /** Snuggle position ids owned by the account (via the LP venue). Empty when `lpUnreadable` is set. */
  lpPositionIds: bigint[];
  /** Ids on the direct Slipstream venue (empty without one); their detail rows are in `lpPositions` with `venue: "direct"`. */
  lpPositionIdsDirect: bigint[];
  /** Per-position detail from the engine (empty when the engine address is unknown). */
  lpPositions: LpPositionRead[];
  /**
   * Set when `positionsOf` refused to answer (slice A, `RISKS.md` §12: the venue names why —
   * out-of-gas, an inconsistent end, an owner mismatch, …) or failed for any other reason. The
   * dashboard then shows the positions as UNREADABLE with this sentence, never as "No positions";
   * `lpPositionIds` and `lpPositions` are empty and mean nothing while it is set.
   */
  lpUnreadable: string | null;
  /** The direct venue's `positionsOf` refused (`PositionsUnreadable`, or a read failure); mirrored into `lpUnreadable` when the engine read was fine. */
  lpUnreadableDirect: string | null;
  /**
   * The direct venue's `unstakedOverflow(account)`: unstaked Slipstream tokens the account holds
   * (any pool) versus how many `positionsOf` scans. `held > scanned` = tokens beyond the window are
   * not listed — a stranger may have sent them (audit wave 3, W3-MED-2). Staked positions are whole.
   */
  lpDirectOverflow: { held: number; scanned: number } | null;
  /** USDC held in the account (hold strategy / un-swept proceeds), base units. */
  accountUsdc: bigint;
  /**
   * True when every USDC debt the read found — the Aave pool's row and each venue's `debt` — is at
   * or below the shared LOAN_DUST_UNITS (slice C, RISKS §8): rounding, not a loan. The dashboard
   * says "no debt" from this, never from `debtUsdc === 0`. False when nothing could be read.
   */
  debtIsDust: boolean;
  /** Native ETH in the wallet, wei — for the gas check. */
  walletEth: bigint | null;
  walletBalances: Partial<Record<"cbBTC" | "WETH" | "USDC" | "cbZEC", bigint>>;
  readAt: string;
  source: ReadSource;
}

type Call = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

/** multicall with per-item failure, falling back to individual calls if the batch throws. */
export async function safeMulticall(client: ReadClient, calls: Call[]): Promise<(unknown | null)[]> {
  if (calls.length === 0) return [];
  try {
    const res = await client.multicall({
      contracts: calls as never,
      allowFailure: true,
    });
    return res.map((r) => (r.status === "success" ? r.result : null));
  } catch {
    return Promise.all(
      calls.map((c) =>
        client
          .readContract({ address: c.address, abi: c.abi as never, functionName: c.functionName, args: c.args as never })
          .catch(() => null),
      ),
    );
  }
}

const RESERVE_SYMBOLS = [...COLLATERAL_SYMBOLS, "USDC"] as const;

export async function readMarket(client: ReadClient): Promise<MarketRead> {
  const calls: Call[] = [];
  for (const s of RESERVE_SYMBOLS) {
    const asset = BASE_TOKENS[s].address;
    calls.push({ address: AAVE_V3.poolDataProvider, abi: POOL_DATA_PROVIDER_ABI, functionName: "getReserveConfigurationData", args: [asset] });
    calls.push({ address: AAVE_V3.poolDataProvider, abi: POOL_DATA_PROVIDER_ABI, functionName: "getReserveData", args: [asset] });
    calls.push({ address: AAVE_V3.oracle, abi: AAVE_ORACLE_ABI, functionName: "getAssetPrice", args: [asset] });
  }
  const out = await safeMulticall(client, calls);
  const reserves = {} as MarketRead["reserves"];
  RESERVE_SYMBOLS.forEach((s, i) => {
    reserves[s] = decodeReserve(s, out[i * 3], out[i * 3 + 1], out[i * 3 + 2]);
  });
  const usdc = reserves.USDC;
  if (!usdc) throw new Error("USDC reserve unreadable — refusing to quote a borrow rate");
  return { reserves, usdcBorrowAprPct: usdc.variableBorrowAprPct, readAt: new Date().toISOString(), source: "live" };
}

/**
 * Decode one reserve. Returns null (= not listed / unreadable) unless BOTH the
 * configuration and the rate tuple decoded — a half-read reserve is not shown.
 * cbZEC returns zeros on Aave (not listed) → null.
 */
export function decodeReserve(symbol: CollateralSymbol | "USDC", cfg: unknown, data: unknown, price: unknown): ReserveParams | null {
  if (!Array.isArray(cfg) || !Array.isArray(data)) return null;
  const [decimals, ltv, lt, bonus, , usageAsCollateralEnabled, borrowingEnabled, , isActive, isFrozen] = cfg as [
    bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean,
  ];
  if (decimals === 0n && lt === 0n && ltv === 0n) return null;
  const liquidityRate = data[5] as bigint;
  const variableBorrowRate = data[6] as bigint;
  const priceUsd = typeof price === "bigint" ? baseUnitsToUsd(price) : NaN;
  return {
    symbol,
    liquidationThresholdBps: Number(lt),
    ltvBps: Number(ltv),
    liquidationBonusBps: Number(bonus) - 10_000,
    usageAsCollateralEnabled,
    borrowingEnabled,
    isActive,
    isFrozen,
    variableBorrowAprPct: rayToAprPct(variableBorrowRate),
    supplyAprPct: rayToAprPct(liquidityRate),
    priceUsd,
  };
}

export interface AccountReadOptions {
  factory?: Address;
  lpVenue?: Address;
  /** The direct Slipstream venue, when the deployment has one: its `positionsOf` is read too. */
  lpVenueDirect?: Address;
  engine?: Address;
  /** CollateralRegistry — enables the venue-aware read. Without it only the Aave leg is read and `venues` is null. */
  registry?: Address;
  /** Wallet ETH balance reader (viem getBalance); optional so tests can omit it. */
  getBalance?: (args: { address: Address }) => Promise<bigint>;
}

/**
 * Discover the rest of the deployment from the router and registry — the
 * env only names the factory and router; everything else is read, and the
 * router's Permit2 must be the canonical one or we refuse to proceed.
 */
export async function readDeployment(client: ReadClient, factory: Address, router: Address, keeper: Address | null): Promise<Deployment> {
  const [registry, lpVenue, swapAdapter, permit2, lpVenueDirectRaw] = await safeMulticall(client, [
    { address: router, abi: ROUTER_ABI, functionName: "REGISTRY" },
    { address: router, abi: ROUTER_ABI, functionName: "LP_VENUE" },
    { address: router, abi: ROUTER_ABI, functionName: "SWAP" },
    { address: router, abi: ROUTER_ABI, functionName: "PERMIT2" },
    // Zero on a deployment without the direct venue; a router from before it has no such view and
    // the row simply fails — both read as "engine venue only" (2026-09-11).
    { address: router, abi: ROUTER_ABI, functionName: "LP_VENUE_DIRECT" },
  ]);
  const lpVenueDirect = typeof lpVenueDirectRaw === "string" && !isZeroAddress(lpVenueDirectRaw) ? (lpVenueDirectRaw as Address) : null;
  if (typeof registry !== "string" || typeof lpVenue !== "string" || typeof permit2 !== "string") throw new Error("router views unreadable");
  if (permit2.toLowerCase() !== PERMIT2.toLowerCase()) throw new Error(`router Permit2 ${permit2} is not the canonical Permit2 — refusing`);
  // The swap adapter is what enforces the unwind's price floor; without it the
  // UI cannot show the number the chain will apply, so refuse rather than guess.
  if (typeof swapAdapter !== "string" || isZeroAddress(swapAdapter)) throw new Error("router has no swap adapter");
  const [aaveVenue, engine] = await safeMulticall(client, [
    { address: registry as Address, abi: COLLATERAL_REGISTRY_ABI, functionName: "venueOf", args: [BASE_TOKENS.cbBTC.address] },
    { address: lpVenue as Address, abi: LP_VENUE_ABI, functionName: "ENGINE" },
  ]);
  if (typeof aaveVenue !== "string" || isZeroAddress(aaveVenue)) throw new Error("registry has no venue for cbBTC");
  if (typeof engine !== "string" || isZeroAddress(engine)) throw new Error("LP venue has no engine");
  const unsupportedVenues = await readUnsupportedVenues(client, registry as Address);
  return {
    factory,
    router,
    registry: registry as Address,
    lpVenue: lpVenue as Address,
    lpVenueDirect,
    aaveVenue: aaveVenue as Address,
    swapAdapter: swapAdapter as Address,
    engine: engine as Address,
    keeper,
    unsupportedVenues,
    demo: false,
  };
}

/**
 * Which ENABLED collateral assets the registry points at a venue this app cannot read THROUGH
 * `ICollateralVenue`. Every account read here goes through that interface to whatever venue the
 * registry names — the Aave venue, the Morpho venue after `acceptVenue`, a future venue — so a
 * venue counts as unsupported only when it does not answer it: `enabled()` false or unreadable, or
 * `liquidationThresholdBps(asset)` zero or unreadable for an enabled asset (audit wave 2, M-HIGH-2).
 * A position on such a venue is invisible here and to the keeper, which refuses to start on it. An
 * unreadable answer counts as unsupported: fail closed. Being an AaveV3Venue is NOT required any more.
 */
export async function readUnsupportedVenues(client: ReadClient, registry: Address): Promise<CollateralSymbol[]> {
  const enabledRows = await safeMulticall(
    client,
    COLLATERAL_SYMBOLS.map((s) => ({ address: registry, abi: COLLATERAL_REGISTRY_ABI, functionName: "isEnabled", args: [BASE_TOKENS[s].address] })),
  );
  const venueRows = await safeMulticall(
    client,
    COLLATERAL_SYMBOLS.map((s) => ({ address: registry, abi: COLLATERAL_REGISTRY_ABI, functionName: "venueOf", args: [BASE_TOKENS[s].address] })),
  );
  const pairs: { symbol: CollateralSymbol; venue: Address }[] = [];
  COLLATERAL_SYMBOLS.forEach((s, i) => {
    if (enabledRows[i] !== true) return;
    const v = venueRows[i];
    if (typeof v === "string" && !isZeroAddress(v)) pairs.push({ symbol: s, venue: v as Address });
  });
  const venueList = [...new Set(pairs.map((p) => p.venue.toLowerCase()))] as Address[];
  const probes = await safeMulticall(client, [
    ...venueList.map((v) => ({ address: v, abi: COLLATERAL_VENUE_ABI, functionName: "enabled" })),
    ...pairs.map((p) => ({ address: p.venue, abi: COLLATERAL_VENUE_ABI, functionName: "liquidationThresholdBps", args: [BASE_TOKENS[p.symbol].address] })),
  ]);
  const venueEnabled = new Map<string, boolean>();
  venueList.forEach((v, i) => venueEnabled.set(v.toLowerCase(), probes[i] === true));
  const out: CollateralSymbol[] = [];
  COLLATERAL_SYMBOLS.forEach((s, i) => {
    if (enabledRows[i] !== true) return;
    const v = venueRows[i];
    if (typeof v !== "string" || isZeroAddress(v)) {
      out.push(s);
      return;
    }
    const pairIdx = pairs.findIndex((p) => p.symbol === s);
    const lt = probes[venueList.length + pairIdx];
    const ok = venueEnabled.get(v.toLowerCase()) === true && typeof lt === "bigint" && lt > 0n;
    if (!ok) out.push(s);
  });
  return out;
}

/**
 * The keeper's tolerance for "the same health factor read twice" is HF_TOLERANCE_BPS = 100
 * (agent/src/config.ts, 1 %): two reads of the pool a block apart drift by interest accrual, never
 * by more than that. The Aave venue's `healthFactor(account)` and the pool's own `getUserAccountData`
 * must agree within it, or the page says "unreadable" rather than pick one.
 */
export const HF_CROSS_CHECK_TOLERANCE = 0.01;

function hfAgree(a: number, b: number): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const ref = Math.max(Math.abs(a), Math.abs(b));
  return ref > 0 && Math.abs(a - b) / ref <= HF_CROSS_CHECK_TOLERANCE;
}

/**
 * Read the account's health from EVERY venue the registry names for its collateral — the current
 * pointer per asset and every previous venue (`previousVenues`, kept by `acceptVenue` so positions
 * opened there stay reachable, M-HIGH-1) — through `ICollateralVenue`. Nothing is defaulted: a venue
 * whose `healthFactor`, `debt` or a collateral/threshold pair did not decode is `readable: false`,
 * and the combined health factor is then `null`.
 */
export async function readVenueHealth(client: ReadClient, registry: Address, account: Address, prices?: VenuePrices): Promise<VenueHealth> {
  const regRows = await safeMulticall(
    client,
    COLLATERAL_SYMBOLS.flatMap((s) => [
      { address: registry, abi: COLLATERAL_REGISTRY_ABI, functionName: "venueOf", args: [BASE_TOKENS[s].address] },
      { address: registry, abi: COLLATERAL_REGISTRY_ABI, functionName: "previousVenues", args: [BASE_TOKENS[s].address] },
      { address: registry, abi: COLLATERAL_REGISTRY_ABI, functionName: "isEnabled", args: [BASE_TOKENS[s].address] },
    ]),
  );
  type Spec = { venue: Address; assets: Map<CollateralSymbol, { enabled: boolean; current: boolean }> };
  const specs = new Map<string, Spec>();
  const unreadable: string[] = [];
  COLLATERAL_SYMBOLS.forEach((s, i) => {
    const cur = regRows[i * 3];
    const prev = regRows[i * 3 + 1];
    const enabled = regRows[i * 3 + 2];
    if (typeof cur !== "string" || !Array.isArray(prev) || typeof enabled !== "boolean") {
      unreadable.push(`registry unreadable for ${s}`);
      return;
    }
    if (isZeroAddress(cur)) return; // not registered: nothing can be opened there
    const add = (venue: string, current: boolean) => {
      const key = venue.toLowerCase();
      const spec = specs.get(key) ?? { venue: venue as Address, assets: new Map() };
      const existing = spec.assets.get(s);
      spec.assets.set(s, { enabled, current: current || (existing?.current ?? false) });
      specs.set(key, spec);
    };
    add(cur, true);
    for (const p of prev as string[]) if (typeof p === "string" && !isZeroAddress(p) && p.toLowerCase() !== cur.toLowerCase()) add(p, false);
  });
  if (unreadable.length) return { registry, venues: [], healthFactor: null, otherDebtUsdc: 0, unreadableReason: unreadable.join("; ") };

  const venueList = [...specs.values()];
  const calls: Call[] = [];
  const plan: { venue: Spec; provider: number; hf: number; debt: number; collateral: { symbol: CollateralSymbol; amount: number; lt: number }[] }[] = [];
  for (const v of venueList) {
    const entry = { venue: v, provider: calls.length, hf: calls.length + 1, debt: calls.length + 2, collateral: [] as { symbol: CollateralSymbol; amount: number; lt: number }[] };
    calls.push({ address: v.venue, abi: AAVE_VENUE_ABI, functionName: "PROVIDER" });
    calls.push({ address: v.venue, abi: COLLATERAL_VENUE_ABI, functionName: "healthFactor", args: [account] });
    calls.push({ address: v.venue, abi: COLLATERAL_VENUE_ABI, functionName: "debt", args: [account, BASE_TOKENS.USDC.address] });
    for (const [sym, a] of v.assets) {
      if (!a.enabled) continue; // an unlisted asset makes some venues revert here; a disabled asset's debt is still in healthFactor / debt
      entry.collateral.push({ symbol: sym, amount: calls.length, lt: calls.length + 1 });
      calls.push({ address: v.venue, abi: COLLATERAL_VENUE_ABI, functionName: "collateral", args: [account, BASE_TOKENS[sym].address] });
      calls.push({ address: v.venue, abi: COLLATERAL_VENUE_ABI, functionName: "liquidationThresholdBps", args: [BASE_TOKENS[sym].address] });
    }
    plan.push(entry);
  }
  const out = await safeMulticall(client, calls);

  const venues: VenueHealthRead[] = plan.map((e) => {
    const provider = out[e.provider];
    const kind: VenueKind = typeof provider === "string" && provider.toLowerCase() === AAVE_V3.poolAddressesProvider.toLowerCase() ? "aave" : "other";
    const hfRaw = out[e.hf];
    const debtRaw = out[e.debt];
    let readable = typeof hfRaw === "bigint" && typeof debtRaw === "bigint";
    // Slice C (RISKS §8): a USDC residual at or below LOAN_DUST_UNITS is rounding, not a book — the
    // venue's finite, enormous health factor for it reads as "no debt" (∞), as the keeper values it.
    const debtIsDust = typeof debtRaw === "bigint" && isLoanDust(debtRaw);
    const collateral = e.collateral.map((c) => {
      const amountRaw = out[c.amount];
      const ltRaw = out[c.lt];
      if (typeof amountRaw !== "bigint" || typeof ltRaw !== "bigint") readable = false;
      const amountAtomic = typeof amountRaw === "bigint" ? amountRaw : 0n;
      return {
        symbol: c.symbol,
        amountAtomic,
        amount: fromAtomic(amountAtomic, COLLATERAL_ASSETS[c.symbol].decimals),
        liquidationThresholdBps: typeof ltRaw === "bigint" ? Number(ltRaw) : null,
      };
    });
    return {
      venue: e.venue.venue,
      kind,
      assets: [...e.venue.assets.keys()],
      current: [...e.venue.assets.values()].some((a) => a.current),
      healthFactor: typeof hfRaw === "bigint" ? (debtIsDust ? Number.POSITIVE_INFINITY : wadHealthFactor(hfRaw)) : null,
      debtUsdc: typeof debtRaw === "bigint" ? fromAtomic(debtRaw, BASE_TOKENS.USDC.decimals) : null,
      debtIsDust,
      collateral,
      readable,
      priceDisagreement: null,
    };
  });
  // Residual (b): a non-Aave venue's health factor is only shown when the prices this app reads
  // agree with it. Without prices (a caller that has none) nothing is cross-checked.
  const checked: VenueHealthRead[] = prices ? venues.map((v) => ({ ...v, priceDisagreement: priceDisagreementOf(v, prices) })) : venues;
  const bad = checked.filter((v) => !v.readable);
  const disputed = checked.filter((v) => v.priceDisagreement !== null);
  const healthFactor = bad.length || disputed.length ? null : checked.reduce((worst, v) => Math.min(worst, v.healthFactor ?? Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
  const otherDebtUsdc = checked.filter((v) => v.kind === "other" && !v.debtIsDust).reduce((a, v) => a + (v.debtUsdc ?? 0), 0);
  return {
    registry,
    venues: checked,
    healthFactor,
    otherDebtUsdc,
    unreadableReason: bad.length
      ? `venue ${bad.map((v) => `${v.venue.slice(0, 6)}…${v.venue.slice(-4)}`).join(", ")} did not answer`
      : disputed.length
        ? disputed.map((v) => v.priceDisagreement).join("; ")
        : null,
  };
}

/**
 * A venue replacement the registry owner has PROPOSED for an asset. Registering
 * a replacement is timelocked (propose → wait TIMELOCK_DELAY → accept) and the
 * pending entry is public, so the UI can say "the lending contract behind this
 * asset is scheduled to change on <date>" while there is still time to act.
 * A timelocked owner is still an owner: the delay is a warning, not a
 * prohibition, and the product says so where it says this.
 */
export interface PendingVenueRead {
  asset: CollateralSymbol;
  currentVenue: Address | null;
  proposedVenue: Address;
  priceFeed: Address;
  /** Unix seconds at which the owner may apply it. */
  eta: number;
}

export async function readPendingVenues(client: ReadClient, registry: Address, symbols: readonly CollateralSymbol[] = COLLATERAL_SYMBOLS): Promise<PendingVenueRead[]> {
  const rows = await safeMulticall(
    client,
    symbols.flatMap((s) => [
      { address: registry, abi: COLLATERAL_REGISTRY_ABI, functionName: "pendingVenue", args: [BASE_TOKENS[s].address] },
      { address: registry, abi: COLLATERAL_REGISTRY_ABI, functionName: "venueOf", args: [BASE_TOKENS[s].address] },
    ]),
  );
  const out: PendingVenueRead[] = [];
  symbols.forEach((s, i) => {
    const p = rows[i * 2] as { venue?: string; priceFeed?: string; eta?: bigint } | null;
    const cur = rows[i * 2 + 1];
    if (!p || typeof p !== "object" || typeof p.venue !== "string" || isZeroAddress(p.venue)) return;
    out.push({
      asset: s,
      currentVenue: typeof cur === "string" && !isZeroAddress(cur) ? (cur as Address) : null,
      proposedVenue: p.venue as Address,
      priceFeed: (p.priceFeed ?? "0x") as Address,
      eta: Number(p.eta ?? 0n),
    });
  });
  return out;
}

/**
 * The keeper permission as it exists on YOUR account: active, expiry,
 * allowCallback, and the per-token budgets with what is already spent in the
 * current window. Returns null when nothing is granted for that key.
 */
export async function readKeeperGrant(client: ReadClient, account: Address, keeper: Address, router: Address, tokenSymbolOf?: (a: Address) => string): Promise<KeeperGrantRead | null> {
  const selector = UNWIND_SELECTOR;
  const [g, toks] = await safeMulticall(client, [
    { address: account, abi: ACCOUNT_ABI, functionName: "grantOf", args: [keeper, router, selector] },
    { address: account, abi: ACCOUNT_ABI, functionName: "grantTokens", args: [keeper, router, selector] },
  ]);
  if (!Array.isArray(g)) return null;
  const [active, maxValuePerPeriod, valueSpent, period, expiry, periodStart, allowCallback] = g as [boolean, bigint, bigint, number | bigint, number | bigint, number | bigint, boolean];
  const tokenList = Array.isArray(toks) ? (toks as Address[]) : [];
  const budgets = tokenList.length
    ? await safeMulticall(
        client,
        tokenList.map((t) => ({ address: account, abi: ACCOUNT_ABI, functionName: "tokenBudgetOf", args: [keeper, router, selector, t] })),
      )
    : [];
  const tokens = tokenList.map((t, i) => {
    const b = budgets[i];
    const [amountPerPeriod, spent] = Array.isArray(b) ? (b as [bigint, bigint]) : [0n, 0n];
    return { token: t, symbol: tokenSymbolOf?.(t) ?? symbolForAddress(t), amountPerPeriod, spent };
  });
  return {
    keeper,
    target: router,
    selector: selector as Hex,
    active: active === true,
    maxValuePerPeriod,
    valueSpent,
    period: Number(period),
    expiry: Number(expiry),
    periodStart: Number(periodStart),
    allowCallback: allowCallback === true,
    tokens,
    readAt: new Date().toISOString(),
  };
}

/** Label a token address from the shared registry; falls back to the short address. */
export function symbolForAddress(a: Address): string {
  for (const [sym, t] of Object.entries(BASE_TOKENS)) {
    if (t.address.toLowerCase() === a.toLowerCase()) return sym;
  }
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Engine positions + range state for a list of ids. Unreadable rows are dropped (never invented). */
export async function readPositions(client: ReadClient, engine: Address, ids: bigint[]): Promise<LpPositionRead[]> {
  if (ids.length === 0) return [];
  const rows = await safeMulticall(
    client,
    ids.map((id) => ({ address: engine, abi: SNUGGLE_VAULT_ABI, functionName: "positions", args: [id] })),
  );
  const out: LpPositionRead[] = [];
  const poolReads: { idx: number; address: Address }[] = [];
  rows.forEach((r, idx) => {
    if (!Array.isArray(r)) return;
    const enginePoolId = String(r[1]) as `0x${string}`;
    const pool = CURATED_POOLS.find((p) => p.enginePoolId?.toLowerCase() === enginePoolId.toLowerCase());
    const p: LpPositionRead = {
      positionId: ids[idx],
      enginePoolId,
      pool,
      venue: "engine",
      rangeWidthBps: Number(r[3]),
      tickLower: Number(r[4]),
      tickUpper: Number(r[5]),
      tick: null,
      inRange: null,
      rebalanceDelayHours: Number(r[8]) / 3600,
      autoCompound: Boolean(r[7]),
      openedAt: Number(r[12]) > 0 ? new Date(Number(r[12]) * 1000).toISOString() : null,
      cumulativeRewardsAtomic: BigInt(r[15] as bigint),
      totalRebalances: Number(r[10]),
    };
    if (pool?.poolAddress) poolReads.push({ idx: out.length, address: pool.poolAddress as Address });
    out.push(p);
  });
  if (poolReads.length) {
    const slots = await safeMulticall(
      client,
      poolReads.map((x) => ({ address: x.address, abi: AERODROME_CLPOOL_ABI, functionName: "slot0" })),
    );
    slots.forEach((s, i) => {
      if (!Array.isArray(s)) return;
      const p = out[poolReads[i].idx];
      p.tick = Number(s[1]);
      p.inRange = isInRange(p.tick, p.tickLower, p.tickUpper);
    });
  }
  return out;
}

/**
 * Positions on the direct Slipstream venue (2026-09-11): the static range and liquidity from the
 * venue's `positionRange(id, account)` (the NFT is the gauge's while staked, so the venue is asked
 * about the ACCOUNT), the pool from the venue's `POOL()`, in-range from the pool's live tick. No
 * rebalancer, no auto-compound, no engine counters: those fields read 0 / false / null.
 */
export async function readDirectPositions(client: ReadClient, venue: Address, account: Address, ids: bigint[]): Promise<LpPositionRead[]> {
  if (ids.length === 0) return [];
  const [poolAddr] = await safeMulticall(client, [{ address: venue, abi: DIRECT_LP_VENUE_ABI, functionName: "POOL" }]);
  const poolAddress = typeof poolAddr === "string" && !isZeroAddress(poolAddr) ? (poolAddr as Address) : null;
  const pool = poolAddress ? CURATED_POOLS.find((p) => p.poolAddress?.toLowerCase() === poolAddress.toLowerCase()) : undefined;
  const poolId = poolAddress ? directPoolId(poolAddress) : (`0x${"0".repeat(64)}` as `0x${string}`);
  const rows = await safeMulticall(
    client,
    ids.map((id) => ({ address: venue, abi: DIRECT_LP_VENUE_ABI, functionName: "positionRange", args: [id, account] })),
  );
  let tick: number | null = null;
  if (poolAddress) {
    const [s] = await safeMulticall(client, [{ address: poolAddress, abi: AERODROME_CLPOOL_ABI, functionName: "slot0" }]);
    if (Array.isArray(s)) tick = Number(s[1]);
  }
  const out: LpPositionRead[] = [];
  rows.forEach((r, idx) => {
    if (!Array.isArray(r)) return;
    const lower = Number(r[0]);
    const upper = Number(r[1]);
    out.push({
      positionId: ids[idx],
      enginePoolId: poolId,
      pool,
      venue: "direct",
      staked: Boolean(r[3]),
      rangeWidthBps: upper - lower,
      tickLower: lower,
      tickUpper: upper,
      tick,
      inRange: tick === null ? null : isInRange(tick, lower, upper),
      rebalanceDelayHours: 0,
      autoCompound: false,
      openedAt: null,
      cumulativeRewardsAtomic: 0n,
      totalRebalances: 0,
    });
  });
  return out;
}

export async function readAccount(
  client: ReadClient,
  owner: Address,
  market: MarketRead,
  opts: AccountReadOptions,
): Promise<AccountRead> {
  const readAt = new Date().toISOString();
  const balances = await safeMulticall(
    client,
    (["cbBTC", "WETH", "USDC", "cbZEC"] as const).map((s) => ({
      address: BASE_TOKENS[s].address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [owner],
    })),
  );
  const walletBalances: AccountRead["walletBalances"] = {};
  (["cbBTC", "WETH", "USDC", "cbZEC"] as const).forEach((s, i) => {
    if (typeof balances[i] === "bigint") walletBalances[s] = balances[i] as bigint;
  });

  const walletEth = opts.getBalance ? await opts.getBalance({ address: owner }).catch(() => null) : null;
  const base: AccountRead = {
    owner,
    account: null,
    deployed: false,
    aave: null,
    venues: null,
    collateral: [],
    debtUsdc: 0,
    lpPositionIds: [],
    lpPositionIdsDirect: [],
    lpPositions: [],
    lpUnreadable: null,
    lpUnreadableDirect: null,
    lpDirectOverflow: null,
    accountUsdc: 0n,
    debtIsDust: false,
    walletEth,
    walletBalances,
    readAt,
    source: "live",
  };
  if (!opts.factory) return base;

  const [predicted] = await safeMulticall(client, [
    { address: opts.factory, abi: FACTORY_ABI, functionName: "accountOf", args: [owner] },
  ]);
  if (typeof predicted !== "string" || isZeroAddress(predicted)) return base;
  const account = predicted as Address;
  const code = await client.getCode({ address: account }).catch(() => undefined);
  const deployed = !!code && code !== "0x";
  if (!deployed) return { ...base, account, deployed };

  const calls: Call[] = [{ address: AAVE_V3.pool, abi: POOL_ABI, functionName: "getUserAccountData", args: [account] }];
  for (const s of COLLATERAL_SYMBOLS) {
    calls.push({ address: AAVE_V3.poolDataProvider, abi: POOL_DATA_PROVIDER_ABI, functionName: "getUserReserveData", args: [BASE_TOKENS[s].address, account] });
  }
  calls.push({ address: AAVE_V3.poolDataProvider, abi: POOL_DATA_PROVIDER_ABI, functionName: "getUserReserveData", args: [BASE_TOKENS.USDC.address, account] });
  calls.push({ address: BASE_TOKENS.USDC.address, abi: ERC20_ABI, functionName: "balanceOf", args: [account] });
  const out = await safeMulticall(client, calls);
  // `positionsOf` is read on its own, not through the multicall: a multicall row that fails loses
  // its revert data, and the venue's refusal to enumerate carries the reason the page must show
  // (slice A, RISKS §12). A failed read is UNREADABLE with that reason, never an empty list.
  let lpPositionIds: bigint[] = [];
  let lpUnreadable: string | null = null;
  if (opts.lpVenue) {
    try {
      const ids = await client.readContract({ address: opts.lpVenue, abi: LP_VENUE_ABI, functionName: "positionsOf", args: [account] });
      if (Array.isArray(ids)) lpPositionIds = ids as bigint[];
      else lpUnreadable = "LP positions unreadable: positionsOf did not return a list — this is not a statement that the account holds no positions";
    } catch (e) {
      const rv = revertOf(e);
      lpUnreadable =
        describeLpEnumerationFault(rv?.name, rv?.args) ??
        `LP positions unreadable: positionsOf failed (${rv?.name ?? (e instanceof Error ? e.message.split("\n")[0] : String(e))}) — this is not a statement that the account holds no positions`;
    }
  }

  // The direct Slipstream venue's own list (2026-09-11), read the same way: on its own, never as a
  // multicall row, so a refusal keeps its name. It fails closed by name (`PositionsUnreadable`)
  // when the gauge or the position manager did not answer.
  let lpPositionIdsDirect: bigint[] = [];
  let lpUnreadableDirect: string | null = null;
  if (opts.lpVenueDirect) {
    try {
      const ids = await client.readContract({ address: opts.lpVenueDirect, abi: DIRECT_LP_VENUE_ABI, functionName: "positionsOf", args: [account] });
      if (Array.isArray(ids)) lpPositionIdsDirect = ids as bigint[];
      else lpUnreadableDirect = "LP positions on the direct venue unreadable: positionsOf did not return a list — this is not a statement that the account holds no positions there";
    } catch (e) {
      const rv = revertOf(e);
      lpUnreadableDirect =
        rv?.name === "PositionsUnreadable"
          ? "LP positions on the direct venue unreadable: the gauge or the position manager did not answer (PositionsUnreadable) — this is not a statement that the account holds no positions there"
          : `LP positions on the direct venue unreadable: positionsOf failed (${rv?.name ?? (e instanceof Error ? e.message.split("\n")[0] : String(e))}) — this is not a statement that the account holds no positions there`;
    }
  }
  if (lpUnreadable === null && lpUnreadableDirect !== null) lpUnreadable = lpUnreadableDirect;
  let lpDirectOverflow: AccountRead["lpDirectOverflow"] = null;
  if (opts.lpVenueDirect && lpUnreadableDirect === null) {
    const [ov] = await safeMulticall(client, [{ address: opts.lpVenueDirect, abi: DIRECT_LP_VENUE_ABI, functionName: "unstakedOverflow", args: [account] }]);
    if (Array.isArray(ov) && typeof ov[0] === "bigint" && typeof ov[1] === "bigint") lpDirectOverflow = { held: Number(ov[0]), scanned: Number(ov[1]) };
  }

  const acct = out[0];
  const usdcRow = out[1 + COLLATERAL_SYMBOLS.length];
  const usdcDebtAtomic = Array.isArray(usdcRow) ? (usdcRow[2] as bigint) + (usdcRow[1] as bigint) : null;
  // Slice C (RISKS §8): the pool's USDC debt at or below LOAN_DUST_UNITS is rounding; its finite,
  // enormous health factor reads as "no debt" (∞) here and in the venue leg, so the two agree.
  const aaveDebtIsDust = usdcDebtAtomic !== null && isLoanDust(usdcDebtAtomic);
  const aave = Array.isArray(acct)
    ? {
        totalCollateralUsd: baseUnitsToUsd(acct[0] as bigint),
        totalDebtUsd: baseUnitsToUsd(acct[1] as bigint),
        availableBorrowsUsd: baseUnitsToUsd(acct[2] as bigint),
        currentLiquidationThresholdBps: Number(acct[3] as bigint),
        ltvBps: Number(acct[4] as bigint),
        healthFactor: aaveDebtIsDust ? Number.POSITIVE_INFINITY : wadHealthFactor(acct[5] as bigint),
      }
    : null;

  const collateral: CollateralHolding[] = [];
  COLLATERAL_SYMBOLS.forEach((s, i) => {
    const r = out[1 + i];
    if (!Array.isArray(r)) return;
    const amountAtomic = r[0] as bigint;
    if (amountAtomic === 0n) return;
    const amount = fromAtomic(amountAtomic, COLLATERAL_ASSETS[s].decimals);
    const price = market.reserves[s]?.priceUsd ?? NaN;
    collateral.push({ symbol: s, amountAtomic, amount, usd: amount * price, venueKind: "aave" });
  });
  const debtUsdc = usdcDebtAtomic !== null ? fromAtomic(usdcDebtAtomic, BASE_TOKENS.USDC.decimals) : 0;
  const usdcBal = out[calls.length - 1];
  const accountUsdc = typeof usdcBal === "bigint" ? usdcBal : 0n;
  const lpPositions = [
    ...(opts.engine ? await readPositions(client, opts.engine, lpPositionIds) : []),
    ...(opts.lpVenueDirect ? await readDirectPositions(client, opts.lpVenueDirect, account, lpPositionIdsDirect) : []),
  ];

  // ---- venue-aware health (audit wave 2, M-HIGH-2) ------------------------------------------
  let venues: VenueHealth | null = null;
  if (opts.registry) {
    venues = await readVenueHealth(client, opts.registry, account, {
      collateral: Object.fromEntries(COLLATERAL_SYMBOLS.map((s) => [s, market.reserves[s]?.priceUsd])) as Partial<Record<CollateralSymbol, number>>,
      usdc: market.reserves.USDC?.priceUsd ?? NaN,
    });
    // The Aave venue reads the same pool as the `aave` leg above. The two must agree, or the page
    // cannot tell which to believe — and a failed pool leg with a readable venue is still "unreadable",
    // never a number pulled from one source when the other is silent.
    const aaveVenues = venues.venues.filter((v) => v.kind === "aave");
    if (venues.healthFactor !== null && aaveVenues.length) {
      if (!aave) {
        venues = { ...venues, healthFactor: null, unreadableReason: "the Aave pool read did not come back" };
      } else {
        const off = aaveVenues.find((v) => v.healthFactor === null || !hfAgree(v.healthFactor, aave.healthFactor));
        if (off) venues = { ...venues, healthFactor: null, unreadableReason: `venue ${off.venue.slice(0, 6)}…${off.venue.slice(-4)} reports HF ${off.healthFactor ?? "?"} but the Aave pool reports ${aave.healthFactor}` };
      }
    }
    // Collateral the account holds on a venue that is not the Aave pool is part of the picture too.
    for (const v of venues.venues) {
      if (v.kind !== "other") continue;
      for (const c of v.collateral) {
        if (c.amountAtomic === 0n) continue;
        const price = market.reserves[c.symbol]?.priceUsd ?? NaN;
        collateral.push({
          symbol: c.symbol,
          amountAtomic: c.amountAtomic,
          amount: c.amount,
          usd: c.amount * price,
          venue: v.venue,
          venueKind: "other",
          ...(c.liquidationThresholdBps !== null ? { liquidationThresholdBps: c.liquidationThresholdBps } : {}),
        });
      }
    }
  }

  const debtIsDust = aaveDebtIsDust && (venues === null || venues.venues.every((v) => v.debtIsDust));
  return { ...base, account, deployed, aave, venues, collateral, debtUsdc, lpPositionIds, lpPositionIdsDirect, lpPositions, lpUnreadable, lpUnreadableDirect, lpDirectOverflow, accountUsdc, debtIsDust };
}

/** The custom error a viem read rejected with, by name, or null when it was not a decoded revert. */
function revertOf(e: unknown): { name: string; args: readonly unknown[] } | null {
  if (!(e instanceof BaseError)) return null;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!r) return null;
  return { name: r.data?.errorName ?? r.reason ?? (r.signature ? `revert ${r.signature}` : "revert"), args: r.data?.args ?? [] };
}
