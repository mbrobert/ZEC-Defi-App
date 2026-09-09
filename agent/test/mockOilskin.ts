import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
} from "viem";
import { AAVE_V3, COLLATERAL_ASSETS, COLLATERAL_SYMBOLS } from "@zyo/shared";
import { aaveVenueAbi, clPoolAbi, collateralRegistryAbi, collateralVenueAbi, erc20BalanceAbi, lpVenueAbi, oilskinAccountAbi, strategyRouterAbi, swapAdapterAbi } from "../src/abi/oilskin.js";
import type { Address } from "../src/types/evm.js";
import { MAX_UINT256 } from "../src/types/evm.js";
import type { MockChain, MockLog } from "./mockChain.js";
import { USDC } from "./fixtures.js";

/**
 * Behavioural mock of OilskinAccount + StrategyRouter + SnuggleLpVenue (+ the
 * swap adapter the router settles through) on top of MockChain.
 *
 * `eth_call` simulations validate without mutating; signed raw transactions
 * (eth_sendRawTransaction) are decoded, sender-recovered, executed against the
 * mock state (positions closed inside the router's nested path, the non-USDC
 * leg swapped under the quote's floor, Aave debt repaid) and given a receipt.
 * Reverts carry real ABI-encoded error data so viem decodes the error name
 * exactly as it would on Base.
 *
 * It models the CONTRACTS AS THEY ARE AFTER FIX ROUND 1:
 *   • `Call` is a 4-tuple ending in `callback`;
 *   • `grantOf` returns 7 values, the last being `allowCallback`;
 *   • `unwind` takes `positionIds` and closes them itself (the keeper no
 *     longer makes a root `closeMany` call — the whole point of D5);
 *   • the swap is bounded by a RATE (`quotedIn`/`quotedOut`/`maxSlippageBps`),
 *     and an unpriced quote reverts `ZeroQuote()`.
 */
export interface MockOilskinOptions {
  router: Address;
  lpVenue: Address;
  usdc?: Address;
  /** `router.REGISTRY()`. Defaults to REGISTRY_ADDR. */
  registry?: Address;
  /** The AaveV3Venue every enabled asset resolves to by default. Defaults to AAVE_VENUE_ADDR. */
  aaveVenue?: Address;
}

export interface MockGrant {
  active: boolean;
  allowCallback: boolean;
  expiry: number;
}

/** What one id pays out when it closes, per pool token. */
export interface CloseYield {
  usdc: bigint;
  other: bigint;
}

/** The non-USDC leg of the default mock pool (8 decimals, like cbBTC/cbZEC). */
export const OTHER_TOKEN = getAddress("0x0000000000000000000000000000000000000e11") as Address;
export const POOL_ADDR = getAddress("0x00000000000000000000000000000000000000b0") as Address;
export const REGISTRY_ADDR = getAddress("0x0000000000000000000000000000000000000e12") as Address;
export const AAVE_VENUE_ADDR = getAddress("0x0000000000000000000000000000000000000e13") as Address;
/**
 * A venue that is NOT an AaveV3Venue — a MorphoBlueVenue stand-in: `PROVIDER()` reverts on it and
 * its ICollateralVenue views answer from the isolated-market state in `MockOilskin.morpho`
 * (worst-market health factor, per-market debt, LLTV read per asset), the shape
 * `contracts/src/venues/MorphoBlueVenue.sol` has.
 */
export const OTHER_VENUE_ADDR = getAddress("0x0000000000000000000000000000000000000e14") as Address;
export const MORPHO_VENUE_ADDR = OTHER_VENUE_ADDR;
/** An address with a contract that answers NOTHING the reader asks — a venue the keeper cannot talk to. */
export const DEAD_VENUE_ADDR = getAddress("0x0000000000000000000000000000000000000e16") as Address;

/** One isolated-market position on the Morpho-style mock venue. */
export interface MockMorphoPosition {
  /** Collateral held in the market, raw units of the collateral token. */
  collateral: bigint;
  /** USDC owed in that market, raw units (6 decimals). */
  debt: bigint;
}

export class MockOilskin {
  readonly usdc: Address;
  /** `${keeper}:${target}:${selector}` (lowercase) → grant */
  grants = new Map<string, MockGrant>();
  positions = new Map<string, { id: bigint; poolId: Hex }[]>();
  poolPrices = new Map<Hex, bigint>();
  /** poolId → (token0, token1, pool). Defaults to (USDC, OTHER_TOKEN, POOL_ADDR). */
  poolTokens = new Map<Hex, { token0: Address; token1: Address; pool: Address }>();
  tokenDecimals = new Map<string, number>([[OTHER_TOKEN.toLowerCase(), 8]]);
  tickSpacing = new Map<string, number>([[POOL_ADDR.toLowerCase(), 200]]);
  usdcBalances = new Map<string, bigint>();
  /** Per-id payout when it closes. */
  closeYield = new Map<bigint, CloseYield>();
  defaultCloseYield: CloseYield = { usdc: 1_000_000_000n, other: 0n };
  /** Execution vs the quoted rate, in bps: 10000 = exactly the quote, 9000 = 10 % worse. */
  swapExecutionBps = 10_000n;
  executed: { account: Address; from: Address; calls: { target: Address; selector: Hex }[]; mutate: boolean }[] = [];
  txFrom: Address[] = [];
  /** Force the next executed tx to revert on-chain (receipt status 0). */
  failNextTx = false;
  /**
   * Audit wave 2, M-HIGH-1: the router resolved a venue that held nothing, found no debt, repaid
   * nothing and SUCCEEDED. This makes the mock's unwind do exactly that — closes go through, the
   * repay leg finds no debt — so the receipt is a success whose `LeveragedLpUnwound.repaid` is 0.
   */
  strandRepay = false;
  /** `LeveragedLpUnwound` logs emitted by the transaction being executed right now. */
  private pendingLogs: MockLog[] = [];
  /**
   * The registry as the venue reader reads it (audit wave 2, M-HIGH-2): which assets are enabled,
   * which venue each resolves to now and resolved to before, and what each venue answers.
   */
  enabledAssets = new Map<string, boolean>(COLLATERAL_SYMBOLS.map((s) => [COLLATERAL_ASSETS[s].address.toLowerCase(), COLLATERAL_ASSETS[s].enabled]));
  venueOf = new Map<string, Address>();
  /** `registry.previousVenues(asset)` — what `acceptVenue` appends on chain (audit wave 2, M-HIGH-1). */
  previousVenuesOf = new Map<string, Address[]>();
  venueProviders = new Map<string, Address | null>();
  /** `venue.enabled()` per venue; default true. */
  venueEnabled = new Map<string, boolean>();
  /** `${venue}:${functionName}` (lowercase) → the call reverts. */
  venueFaults = new Set<string>();
  /** `${venue}:${functionName}` (lowercase) → a fixed answer instead of the derived one (to make a venue lie). */
  venueOverrides = new Map<string, bigint>();
  /** `${functionName}:${asset}` (lowercase) → the registry call reverts. */
  registryFaults = new Set<string>();
  /**
   * Isolated-market venue state behind every NON-Aave mock venue (the Morpho stand-in). LLTV per
   * collateral defaults to the 86 % both verified Base markets carry (docs/VERIFIED-BASE-FACTS.md,
   * 2026-09-07); the market oracle price defaults to the chain's Aave price for the asset, so the
   * venue and the keeper's feed agree unless a test moves one of them.
   */
  morpho = {
    lltvBps: new Map<string, bigint>(
      COLLATERAL_SYMBOLS.filter((s) => COLLATERAL_ASSETS[s].enabled).map((s) => [COLLATERAL_ASSETS[s].address.toLowerCase(), 8600n])
    ),
    /** Market oracle price: USDC per one collateral unit, 8 decimals (the mock of Morpho's 1e36-scaled price). */
    price8: new Map<string, bigint>(),
    positions: new Map<string, Map<string, MockMorphoPosition>>(),
  };

  constructor(
    private readonly chain: MockChain,
    private readonly opts: MockOilskinOptions
  ) {
    this.usdc = opts.usdc ?? USDC;
  }

  grant(keeper: Address, target: Address, selector: Hex, over: Partial<MockGrant> = {}): void {
    this.grants.set(`${keeper}:${target}:${selector}`.toLowerCase(), {
      active: true,
      allowCallback: true,
      expiry: 4_102_444_800,
      ...over,
    });
  }
  revoke(keeper: Address, target: Address, selector: Hex): void {
    this.grants.delete(`${keeper}:${target}:${selector}`.toLowerCase());
  }
  isGranted(keeper: Address, target: Address, selector: Hex): boolean {
    const g = this.grants.get(`${keeper}:${target}:${selector}`.toLowerCase());
    return g !== undefined && g.active;
  }
  setPositions(account: Address, list: { id: bigint; poolId: Hex }[]): void {
    this.positions.set(account.toLowerCase(), [...list]);
  }
  setUsdc(account: Address, amount: bigint): void {
    this.usdcBalances.set(account.toLowerCase(), amount);
  }
  /** Convenience: what this id is worth in USDC when closed. */
  setCloseYield(id: bigint, usdc: bigint, other = 0n): void {
    this.closeYield.set(id, { usdc, other });
  }
  yieldOf(id: bigint): CloseYield {
    return this.closeYield.get(id) ?? this.defaultCloseYield;
  }
  tokensOf(poolId: Hex): { token0: Address; token1: Address; pool: Address } {
    return this.poolTokens.get(poolId) ?? { token0: this.usdc, token1: OTHER_TOKEN, pool: POOL_ADDR };
  }
  get registry(): Address {
    return this.opts.registry ?? REGISTRY_ADDR;
  }
  get aaveVenue(): Address {
    return this.opts.aaveVenue ?? AAVE_VENUE_ADDR;
  }
  /**
   * Point `asset` at `venue` in the mock registry and remember the venue it replaced in
   * `previousVenues`, exactly what `acceptVenue` does on chain (audit wave 2, M-HIGH-1).
   * Pass `remember: false` to model a registry that was DEPLOYED pointing there.
   */
  setVenue(asset: Address, venue: Address, remember = true): void {
    const key = asset.toLowerCase();
    const previous = this.venueOf.get(key) ?? this.aaveVenue;
    if (remember && previous.toLowerCase() !== venue.toLowerCase()) {
      const list = this.previousVenuesOf.get(key) ?? [];
      if (!list.some((v) => v.toLowerCase() === previous.toLowerCase())) list.push(previous);
      this.previousVenuesOf.set(key, list.filter((v) => v.toLowerCase() !== venue.toLowerCase()));
    }
    this.venueOf.set(key, venue);
  }
  setPreviousVenues(asset: Address, venues: Address[]): void {
    this.previousVenuesOf.set(asset.toLowerCase(), [...venues]);
  }
  setEnabled(asset: Address, enabled: boolean): void {
    this.enabledAssets.set(asset.toLowerCase(), enabled);
  }
  /** What `venue.PROVIDER()` answers; `null` makes the call revert (a venue with no such view). */
  setVenueProvider(venue: Address, provider: Address | null): void {
    this.venueProviders.set(venue.toLowerCase(), provider);
  }
  /** Make one ICollateralVenue view on one venue revert. */
  failVenueCall(venue: Address, functionName: string): void {
    this.venueFaults.add(`${venue}:${functionName}`.toLowerCase());
  }
  /** Make one ICollateralVenue view on one venue answer a fixed word (a venue that lies). */
  overrideVenueAnswer(venue: Address, functionName: string, value: bigint): void {
    this.venueOverrides.set(`${venue}:${functionName}`.toLowerCase(), value);
  }
  failRegistryCall(functionName: string, asset: Address): void {
    this.registryFaults.add(`${functionName}:${asset}`.toLowerCase());
  }
  /** A Morpho-style position for `account` in `asset`'s market on every non-Aave mock venue. */
  setMorphoPosition(account: Address, asset: Address, pos: MockMorphoPosition): void {
    const a = account.toLowerCase();
    if (!this.morpho.positions.has(a)) this.morpho.positions.set(a, new Map());
    this.morpho.positions.get(a)!.set(asset.toLowerCase(), { ...pos });
  }
  /** The Morpho market's oracle price for `asset` (USDC per unit, 8 decimals). */
  setMorphoPrice(asset: Address, price8: bigint): void {
    this.morpho.price8.set(asset.toLowerCase(), price8);
  }
  setMorphoLltv(asset: Address, bps: bigint): void {
    this.morpho.lltvBps.set(asset.toLowerCase(), bps);
  }
  morphoPosition(account: Address, asset: Address): MockMorphoPosition {
    return this.morpho.positions.get(account.toLowerCase())?.get(asset.toLowerCase()) ?? { collateral: 0n, debt: 0n };
  }
  private morphoPrice8(asset: string): bigint {
    return this.morpho.price8.get(asset) ?? this.chain.reserves.get(asset)?.aavePrice ?? 0n;
  }
  private assetDecimals(asset: string): number {
    return this.chain.reserves.get(asset)?.decimals ?? this.tokenDecimals.get(asset) ?? 18;
  }
  /** Worst-market health factor, WAD, as `MorphoBlueVenue._healthFactor` computes it; MAX with no debt. */
  morphoHealthFactor(account: Address): bigint {
    let worst = MAX_UINT256;
    for (const [asset, pos] of this.morpho.positions.get(account.toLowerCase()) ?? []) {
      if (pos.debt === 0n) continue;
      const value8 = (pos.collateral * this.morphoPrice8(asset)) / 10n ** BigInt(this.assetDecimals(asset));
      const maxBorrow8 = (value8 * (this.morpho.lltvBps.get(asset) ?? 0n)) / 10_000n;
      const debt8 = pos.debt * 100n; // USDC 6 dp → 8 dp
      const hf = (maxBorrow8 * 10n ** 18n) / debt8;
      if (hf < worst) worst = hf;
    }
    return worst;
  }
  morphoDebt(account: Address): bigint {
    let total = 0n;
    for (const pos of (this.morpho.positions.get(account.toLowerCase()) ?? new Map<string, MockMorphoPosition>()).values()) total += pos.debt;
    return total;
  }
  private isAaveKind(venue: string): boolean {
    const provider = this.venueProviders.has(venue) ? this.venueProviders.get(venue) : (AAVE_V3.poolAddressesProvider as Address);
    return !!provider && provider.toLowerCase() === AAVE_V3.poolAddressesProvider.toLowerCase();
  }

  install(accounts: Address[]): void {
    const c = this.chain.contracts;
    c.set(this.opts.router.toLowerCase(), (data) => {
      const { functionName } = decodeFunctionData({ abi: strategyRouterAbi, data });
      if (functionName === "USDC") return encodeFunctionResult({ abi: strategyRouterAbi, functionName, result: this.usdc });
      if (functionName === "LP_VENUE") return encodeFunctionResult({ abi: strategyRouterAbi, functionName, result: this.opts.lpVenue });
      if (functionName === "REGISTRY") return encodeFunctionResult({ abi: strategyRouterAbi, functionName, result: this.registry });
      throw revert("mock router: not callable directly");
    });
    c.set(this.registry.toLowerCase(), (data) => {
      const { functionName, args } = decodeFunctionData({ abi: collateralRegistryAbi, data });
      const [asset] = args as [Address];
      if (this.registryFaults.has(`${functionName}:${asset}`.toLowerCase())) throw revert(`mock registry: ${functionName} fault`);
      if (functionName === "isEnabled") {
        return encodeFunctionResult({ abi: collateralRegistryAbi, functionName, result: this.enabledAssets.get(asset.toLowerCase()) ?? false });
      }
      if (functionName === "venueOf") {
        return encodeFunctionResult({ abi: collateralRegistryAbi, functionName, result: this.venueOf.get(asset.toLowerCase()) ?? this.aaveVenue });
      }
      if (functionName === "previousVenues") {
        return encodeFunctionResult({ abi: collateralRegistryAbi, functionName, result: this.previousVenuesOf.get(asset.toLowerCase()) ?? [] });
      }
      throw revert("mock registry: unsupported");
    });
    this.installVenue(this.aaveVenue);
    this.venueProviders.set(OTHER_VENUE_ADDR.toLowerCase(), null);
    this.installVenue(OTHER_VENUE_ADDR);
    this.installDeadVenue(DEAD_VENUE_ADDR);
    c.set(this.opts.lpVenue.toLowerCase(), (data) => {
      const { functionName, args } = decodeFunctionData({ abi: lpVenueAbi, data });
      if (functionName === "positionsOf") {
        const [acct] = args as [Address];
        return encodeFunctionResult({ abi: lpVenueAbi, functionName, result: (this.positions.get(acct.toLowerCase()) ?? []).map((p) => p.id) });
      }
      if (functionName === "poolOf") {
        const [id] = args as [bigint];
        for (const [acct, list] of this.positions) {
          const p = list.find((x) => x.id === id);
          if (p) return encodeFunctionResult({ abi: lpVenueAbi, functionName, result: [p.poolId, acct as Address] });
        }
        throw revert("mock venue: unknown id");
      }
      if (functionName === "poolSqrtPriceX96") {
        const [poolId] = args as [Hex];
        const price = this.poolPrices.get(poolId);
        if (price === undefined) throw revert("mock venue: unknown pool");
        return encodeFunctionResult({ abi: lpVenueAbi, functionName, result: price });
      }
      if (functionName === "poolTokens") {
        const [poolId] = args as [Hex];
        if (this.poolPrices.get(poolId) === undefined && !this.poolTokens.has(poolId)) throw revert("mock venue: unknown pool");
        const t = this.tokensOf(poolId);
        return encodeFunctionResult({ abi: lpVenueAbi, functionName, result: [t.token0, t.token1, t.pool] });
      }
      throw revert("mock venue: not callable directly");
    });
    c.set(this.usdc.toLowerCase(), (data) => this.erc20Call(this.usdc, data));
    c.set(OTHER_TOKEN.toLowerCase(), (data) => this.erc20Call(OTHER_TOKEN, data));
    c.set(POOL_ADDR.toLowerCase(), (data) => {
      const { functionName } = decodeFunctionData({ abi: clPoolAbi, data });
      if (functionName !== "tickSpacing") throw revert("mock pool");
      return encodeFunctionResult({ abi: clPoolAbi, functionName, result: this.tickSpacing.get(POOL_ADDR.toLowerCase()) ?? 200 });
    });
    for (const account of accounts) {
      c.set(account.toLowerCase(), (data, from) => this.accountCall(account, data, from, false));
    }
    this.chain.onSendRawTransaction = async (raw) => {
      const tx = parseTransaction(raw);
      const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })) as Address;
      this.txFrom.push(from);
      const hash = keccak256(raw);
      const to = (tx.to ?? "0x").toLowerCase();
      if (!accounts.some((a) => a.toLowerCase() === to)) {
        this.chain.receipts.set(hash.toLowerCase(), { status: "0x0", blockNumber: this.chain.blockNumber });
        return hash;
      }
      let status: "0x1" | "0x0" = "0x1";
      this.pendingLogs = [];
      if (this.failNextTx) {
        this.failNextTx = false;
        status = "0x0";
      } else {
        try {
          this.accountCall(to as Address, tx.data as Hex, from, true);
        } catch {
          status = "0x0";
        }
      }
      this.chain.receipts.set(hash.toLowerCase(), {
        status,
        blockNumber: this.chain.blockNumber,
        logs: status === "0x1" ? [...this.pendingLogs] : [],
      });
      this.pendingLogs = [];
      this.chain.txCount.set(from.toLowerCase(), (this.chain.txCount.get(from.toLowerCase()) ?? 0) + 1);
      return hash;
    };
  }

  /**
   * Put a venue contract at `venue`. `PROVIDER()` answers per `setVenueProvider` (Aave's by
   * default; `null` reverts). The ICollateralVenue views answer from the chain's Aave state when
   * the provider is the shared Aave one (an `AaveV3Venue` over the pool the keeper reads), and from
   * the isolated-market `morpho` state otherwise.
   */
  installVenue(venue: Address): void {
    const key = venue.toLowerCase();
    const abi = [...aaveVenueAbi, ...collateralVenueAbi] as const;
    this.chain.contracts.set(key, (data: Hex) => {
      const { functionName, args } = decodeFunctionData({ abi, data });
      const fnKey = `${key}:${functionName}`.toLowerCase();
      if (this.venueFaults.has(fnKey)) throw revert(`mock venue: ${functionName} fault`);
      const override = this.venueOverrides.get(fnKey);
      if (functionName === "PROVIDER") {
        const provider = this.venueProviders.has(key) ? this.venueProviders.get(key) : (AAVE_V3.poolAddressesProvider as Address);
        if (provider === null || provider === undefined) throw revert("mock venue: no PROVIDER() here");
        return encodeFunctionResult({ abi, functionName, result: provider });
      }
      if (functionName === "enabled") return encodeFunctionResult({ abi, functionName, result: this.venueEnabled.get(key) ?? true });
      const aave = this.isAaveKind(key);
      if (functionName === "healthFactor") {
        const [acct] = args as [Address];
        const hf = override ?? (aave ? this.chain.accountData(acct)[5] : this.morphoHealthFactor(acct));
        return encodeFunctionResult({ abi, functionName, result: hf });
      }
      if (functionName === "debt") {
        const [acct, asset] = args as [Address, Address];
        let owed: bigint;
        if (aave) {
          const u = this.chain.users.get(acct.toLowerCase())?.get(asset.toLowerCase());
          owed = u ? u.stableDebt + u.variableDebt : 0n;
        } else {
          owed = asset.toLowerCase() === this.usdc.toLowerCase() ? this.morphoDebt(acct) : 0n;
        }
        return encodeFunctionResult({ abi, functionName, result: override ?? owed });
      }
      if (functionName === "collateral") {
        const [acct, asset] = args as [Address, Address];
        const held = aave ? (this.chain.users.get(acct.toLowerCase())?.get(asset.toLowerCase())?.aTokenBalance ?? 0n) : this.morphoPosition(acct, asset).collateral;
        return encodeFunctionResult({ abi, functionName, result: override ?? held });
      }
      if (functionName === "liquidationThresholdBps") {
        const [asset] = args as [Address];
        const lt = aave ? (this.chain.reserves.get(asset.toLowerCase())?.liquidationThresholdBps ?? 0n) : (this.morpho.lltvBps.get(asset.toLowerCase()) ?? 0n);
        return encodeFunctionResult({ abi, functionName, result: override ?? lt });
      }
      throw revert("mock venue: unsupported");
    });
  }

  /** A contract that reverts on every call — a venue address the reader cannot talk to. */
  installDeadVenue(venue: Address): void {
    this.chain.contracts.set(venue.toLowerCase(), () => {
      throw revert("dead venue: no such function");
    });
  }

  private erc20Call(token: Address, data: Hex): Hex {
    const { functionName, args } = decodeFunctionData({ abi: erc20BalanceAbi, data });
    if (functionName === "balanceOf") {
      const [acct] = args as [Address];
      if (token.toLowerCase() !== this.usdc.toLowerCase()) return encodeFunctionResult({ abi: erc20BalanceAbi, functionName, result: 0n });
      return encodeFunctionResult({ abi: erc20BalanceAbi, functionName, result: this.usdcBalances.get(acct.toLowerCase()) ?? 0n });
    }
    if (functionName === "decimals") {
      const d = token.toLowerCase() === this.usdc.toLowerCase() ? 6 : (this.tokenDecimals.get(token.toLowerCase()) ?? 18);
      return encodeFunctionResult({ abi: erc20BalanceAbi, functionName, result: d });
    }
    throw revert("mock token");
  }

  private accountCall(account: Address, data: Hex, from: Address | undefined, mutate: boolean): Hex {
    const { functionName, args } = decodeFunctionData({ abi: oilskinAccountAbi, data });
    if (functionName === "grantOf") {
      const [keeper, target, selector] = args as [Address, Address, Hex];
      const g = this.grants.get(`${keeper}:${target}:${selector}`.toLowerCase());
      return encodeFunctionResult({
        abi: oilskinAccountAbi,
        functionName,
        result: [g?.active === true, 0n, 0n, 86400, g?.expiry ?? 0, 0, g?.allowCallback === true],
      });
    }
    if (functionName === "execAsKeeper") {
      const [calls] = args as unknown as [{ target: Address; value: bigint; data: Hex; callback: boolean }[]];
      const keeper = (from ?? "0x0000000000000000000000000000000000000000") as Address;
      const rec = { account, from: keeper, calls: [] as { target: Address; selector: Hex }[], mutate };
      const results: Hex[] = [];
      // Snapshot so a dry run never mutates.
      const snap = mutate ? null : this.snapshot();
      try {
        for (const call of calls) {
          const selector = call.data.slice(0, 10) as Hex;
          rec.calls.push({ target: call.target, selector });
          const g = this.grants.get(`${keeper}:${call.target}:${selector}`.toLowerCase());
          if (!g?.active) {
            throw revertWith(encodeErrorResult({ abi: oilskinAccountAbi, errorName: "NotGranted", args: [keeper, call.target, selector] }));
          }
          // The account reads the GRANT's allowCallback, never the call's flag:
          // the router must act back on the account, so a grant without it is a
          // NotActivePeripheral revert raised inside the router's frame.
          if (!g.allowCallback) {
            throw revertWith(encodeErrorResult({ abi: oilskinAccountAbi, errorName: "NotActivePeripheral" }));
          }
          results.push(this.runRootCall(account, call.target, call.data));
        }
      } finally {
        if (snap) this.restore(snap);
        this.executed.push(rec);
      }
      return encodeFunctionResult({ abi: oilskinAccountAbi, functionName, result: results });
    }
    throw revert("mock account: unsupported");
  }

  private runRootCall(account: Address, target: Address, data: Hex): Hex {
    const acct = account.toLowerCase();
    if (target.toLowerCase() !== this.opts.router.toLowerCase()) {
      // After D5 the keeper's ONLY root call is StrategyRouter.unwind. Anything
      // else means a plan reached outside the single signed grant.
      throw revert(`mock: unknown root target ${target}`);
    }
    const { functionName, args } = decodeFunctionData({ abi: strategyRouterAbi, data });
    if (functionName !== "unwind") throw revert("mock router: only unwind");
    const [p] = args as unknown as [
      {
        collateralAsset: Address;
        positionIds: readonly bigint[];
        band: { minSqrtPriceX96: bigint; maxSqrtPriceX96: bigint };
        swap: { quotedIn: bigint; quotedOut: bigint; maxSlippageBps: number; routeData: Hex };
        repayAmount: bigint;
        withdrawAmount: bigint;
        deadline: bigint;
      },
    ];
    if (p.deadline < this.chain.nowS) throw revertWith(encodeErrorResult({ abi: strategyRouterAbi, errorName: "Expired", args: [p.deadline] }));
    if (p.withdrawAmount !== 0n) throw revert("mock router: keeper must not withdraw");

    let usdcFromLp = 0n;
    let closedCount = 0;
    let failedCount = 0;
    if (p.positionIds.length !== 0) {
      const settled = this.closeAndSettle(acct, p);
      usdcFromLp = settled.proceeds;
      closedCount = settled.closed;
      failedCount = settled.failed;
    }

    let repaid = 0n;
    if (p.repayAmount !== 0n && !this.strandRepay) {
      // The router's exit path follows the position (audit wave 2, M-HIGH-1): the Aave debt when
      // there is one, else the Morpho-style market of the collateral asset the call names.
      const user = this.chain.users.get(acct)?.get(this.usdc.toLowerCase());
      const aaveOwed = user ? user.variableDebt + user.stableDebt : 0n;
      const morphoPos = aaveOwed === 0n ? this.morphoPosition(account as Address, p.collateralAsset) : null;
      const owed = morphoPos ? morphoPos.debt : aaveOwed;
      const held = this.usdcBalances.get(acct) ?? 0n;
      let amount = p.repayAmount === MAX_UINT256 ? (owed < held ? owed : held) : p.repayAmount;
      if (amount > held) throw revert("ERC20: transfer amount exceeds balance");
      if (amount > owed) amount = owed;
      if (amount !== 0n) {
        if (morphoPos) this.setMorphoPosition(account as Address, p.collateralAsset, { ...morphoPos, debt: morphoPos.debt - amount });
        else if (user) user.variableDebt -= amount;
        this.usdcBalances.set(acct, held - amount);
        repaid = amount;
      }
    }
    const [, , , , , aaveHf] = this.chain.accountData(account as Address);
    const morphoHf = this.morphoHealthFactor(account as Address);
    const hf = aaveHf < morphoHf ? aaveHf : morphoHf;
    // The router's event, exactly as the keeper's `confirm` reads it from the receipt.
    const topics = encodeEventTopics({
      abi: strategyRouterAbi,
      eventName: "LeveragedLpUnwound",
      args: { account: account as Address, collateralAsset: p.collateralAsset },
    }) as Hex[];
    const eventData = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [BigInt(closedCount), BigInt(failedCount), usdcFromLp, repaid, 0n, hf]
    );
    this.pendingLogs.push({ address: this.opts.router, topics, data: eventData, blockNumber: this.chain.blockNumber, logIndex: this.pendingLogs.length });
    return encodeFunctionResult({ abi: strategyRouterAbi, functionName, result: [usdcFromLp, repaid, 0n, hf] });
  }

  /** The router's `_closeAndSettle`: venue close (per-id try/catch) then swap the non-USDC leg. */
  private closeAndSettle(
    acct: string,
    p: {
      positionIds: readonly bigint[];
      band: { minSqrtPriceX96: bigint; maxSqrtPriceX96: bigint };
      swap: { quotedIn: bigint; quotedOut: bigint; maxSlippageBps: number; routeData: Hex };
    }
  ): { proceeds: bigint; closed: number; failed: number } {
    if (p.band.minSqrtPriceX96 === 0n || p.band.maxSqrtPriceX96 === 0n || p.band.minSqrtPriceX96 > p.band.maxSqrtPriceX96) {
      throw revertWith(encodeErrorResult({ abi: lpVenueAbi, errorName: "BandRequired" }));
    }
    const list = this.positions.get(acct) ?? [];
    // Pool comes from the first id the account ACTUALLY OWNS (index 0 is not special).
    const first = p.positionIds.map((id) => list.find((x) => x.id === id)).find((x) => x !== undefined);
    if (!first) return { proceeds: 0n, closed: 0, failed: p.positionIds.length }; // every id stale: reported as failed, never a revert
    const poolId = first.poolId;
    const price = this.poolPrices.get(poolId) ?? 0n;
    if (price < p.band.minSqrtPriceX96 || price > p.band.maxSqrtPriceX96) {
      throw revertWith(encodeErrorResult({ abi: lpVenueAbi, errorName: "PriceOutOfBand", args: [price, p.band.minSqrtPriceX96, p.band.maxSqrtPriceX96] }));
    }
    let outUsdc = 0n;
    let outOther = 0n;
    const closed: bigint[] = [];
    for (const id of p.positionIds) {
      const pos = list.find((x) => x.id === id);
      if (!pos || pos.poolId !== poolId) continue; // → `failed`, not fatal
      const y = this.yieldOf(id);
      outUsdc += y.usdc;
      outOther += y.other;
      closed.push(id);
    }
    this.positions.set(acct, list.filter((x) => !closed.includes(x.id)));

    let proceeds = outUsdc;
    if (outOther > 0n) proceeds += this.swapToUsdc(outOther, p.swap);
    this.usdcBalances.set(acct, (this.usdcBalances.get(acct) ?? 0n) + proceeds);
    return { proceeds, closed: closed.length, failed: p.positionIds.length - closed.length };
  }

  /** AerodromeSwapAdapter: a RATE-derived floor on the amount actually swapped. */
  private swapToUsdc(amountIn: bigint, q: { quotedIn: bigint; quotedOut: bigint; maxSlippageBps: number }): bigint {
    if (q.quotedIn === 0n || q.quotedOut === 0n) {
      throw revertWith(encodeErrorResult({ abi: swapAdapterAbi, errorName: "ZeroQuote" }));
    }
    if (q.maxSlippageBps > 500) {
      throw revertWith(encodeErrorResult({ abi: swapAdapterAbi, errorName: "SlippageTooHigh", args: [q.maxSlippageBps, 500] }));
    }
    const atQuote = (amountIn * q.quotedOut) / q.quotedIn;
    const minOut = (atQuote * BigInt(10_000 - q.maxSlippageBps)) / 10_000n;
    if (minOut === 0n) throw revertWith(encodeErrorResult({ abi: swapAdapterAbi, errorName: "ZeroQuote" }));
    const out = (atQuote * this.swapExecutionBps) / 10_000n;
    if (out < minOut) {
      throw revertWith(encodeErrorResult({ abi: swapAdapterAbi, errorName: "InsufficientOutput", args: [out, minOut] }));
    }
    return out;
  }

  private snapshot() {
    return {
      positions: new Map([...this.positions].map(([k, v]) => [k, [...v]])),
      usdc: new Map(this.usdcBalances),
      users: structuredClone(this.chain.users),
      morpho: new Map([...this.morpho.positions].map(([k, v]) => [k, new Map([...v].map(([a, p]) => [a, { ...p }]))])),
    };
  }
  private restore(s: ReturnType<MockOilskin["snapshot"]>) {
    this.positions = s.positions;
    this.usdcBalances = s.usdc;
    this.chain.users = s.users;
    this.morpho.positions = s.morpho;
  }
}

function revert(message: string): Error & { code: number; data?: Hex } {
  return Object.assign(new Error(`execution reverted: ${message}`), { code: 3 });
}
function revertWith(data: Hex): Error & { code: number; data: Hex } {
  return Object.assign(new Error("execution reverted"), { code: 3, data });
}
