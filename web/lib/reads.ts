/**
 * Chain reads (viem). The dashboard and the wizard read Aave reserve
 * parameters, oracle prices, the connected wallet's OilskinAccount and its
 * Aave position FROM CHAIN. The indexer is only a cache the UI paints from
 * while these resolve (see lib/indexer.ts).
 *
 * Reads are batched through viem `multicall` (Multicall3 from viem's `base`
 * chain definition) and fall back to one eth_call per item if the batch
 * itself fails, so a missing/reverting multicall never blanks the page.
 */
import type { Address, Hex } from "viem";
import { AAVE_V3, BASE_TOKENS, COLLATERAL_ASSETS, COLLATERAL_SYMBOLS, isZeroAddress, type CollateralSymbol } from "@zyo/shared";
import { AAVE_ORACLE_ABI, ERC20_ABI, POOL_ABI, POOL_DATA_PROVIDER_ABI } from "./abi/aave";
import { ACCOUNT_ABI, AERODROME_CLPOOL_ABI, COLLATERAL_REGISTRY_ABI, FACTORY_ABI, LP_VENUE_ABI, ROUTER_ABI, SNUGGLE_VAULT_ABI } from "./abi/oilskin";
import { baseUnitsToUsd, fromAtomic, rayToAprPct, wadHealthFactor } from "./math";
import type { KeeperGrantRead } from "./keeper";
import { UNWIND_SELECTOR, type Deployment } from "./plan";
import { isInRange } from "./tickmath";
import { CURATED_POOLS, PERMIT2, type CuratedPool } from "@zyo/shared";

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
}

/** One engine position as read from chain (ISnuggleVault.positions + the pool's slot0). */
export interface LpPositionRead {
  positionId: bigint;
  enginePoolId: `0x${string}`;
  pool: CuratedPool | undefined;
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
  aave: {
    totalCollateralUsd: number;
    totalDebtUsd: number;
    availableBorrowsUsd: number;
    currentLiquidationThresholdBps: number;
    ltvBps: number;
    healthFactor: number;
  } | null;
  collateral: CollateralHolding[];
  debtUsdc: number;
  /** Snuggle position ids owned by the account (via the LP venue). */
  lpPositionIds: bigint[];
  /** Per-position detail from the engine (empty when the engine address is unknown). */
  lpPositions: LpPositionRead[];
  /** USDC held in the account (hold strategy / un-swept proceeds), base units. */
  accountUsdc: bigint;
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
  engine?: Address;
  /** Wallet ETH balance reader (viem getBalance); optional so tests can omit it. */
  getBalance?: (args: { address: Address }) => Promise<bigint>;
}

/**
 * Discover the rest of the deployment from the router and registry — the
 * env only names the factory and router; everything else is read, and the
 * router's Permit2 must be the canonical one or we refuse to proceed.
 */
export async function readDeployment(client: ReadClient, factory: Address, router: Address, keeper: Address | null): Promise<Deployment> {
  const [registry, lpVenue, swapAdapter, permit2] = await safeMulticall(client, [
    { address: router, abi: ROUTER_ABI, functionName: "REGISTRY" },
    { address: router, abi: ROUTER_ABI, functionName: "LP_VENUE" },
    { address: router, abi: ROUTER_ABI, functionName: "SWAP" },
    { address: router, abi: ROUTER_ABI, functionName: "PERMIT2" },
  ]);
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
  return {
    factory,
    router,
    registry: registry as Address,
    lpVenue: lpVenue as Address,
    aaveVenue: aaveVenue as Address,
    swapAdapter: swapAdapter as Address,
    engine: engine as Address,
    keeper,
    demo: false,
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
    collateral: [],
    debtUsdc: 0,
    lpPositionIds: [],
    lpPositions: [],
    accountUsdc: 0n,
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
  if (opts.lpVenue) calls.push({ address: opts.lpVenue, abi: LP_VENUE_ABI, functionName: "positionsOf", args: [account] });
  calls.push({ address: BASE_TOKENS.USDC.address, abi: ERC20_ABI, functionName: "balanceOf", args: [account] });
  const out = await safeMulticall(client, calls);

  const acct = out[0];
  const aave = Array.isArray(acct)
    ? {
        totalCollateralUsd: baseUnitsToUsd(acct[0] as bigint),
        totalDebtUsd: baseUnitsToUsd(acct[1] as bigint),
        availableBorrowsUsd: baseUnitsToUsd(acct[2] as bigint),
        currentLiquidationThresholdBps: Number(acct[3] as bigint),
        ltvBps: Number(acct[4] as bigint),
        healthFactor: wadHealthFactor(acct[5] as bigint),
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
    collateral.push({ symbol: s, amountAtomic, amount, usd: amount * price });
  });
  const usdcRow = out[1 + COLLATERAL_SYMBOLS.length];
  const debtUsdc = Array.isArray(usdcRow) ? fromAtomic((usdcRow[2] as bigint) + (usdcRow[1] as bigint), BASE_TOKENS.USDC.decimals) : 0;
  const lpRow = opts.lpVenue ? out[2 + COLLATERAL_SYMBOLS.length] : null;
  const lpPositionIds = Array.isArray(lpRow) ? (lpRow as bigint[]) : [];
  const usdcBal = out[calls.length - 1];
  const accountUsdc = typeof usdcBal === "bigint" ? usdcBal : 0n;
  const lpPositions = opts.engine ? await readPositions(client, opts.engine, lpPositionIds) : [];

  return { ...base, account, deployed, aave, collateral, debtUsdc, lpPositionIds, lpPositions, accountUsdc };
}
