import {
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
} from "viem";
import { clPoolAbi, erc20BalanceAbi, lpVenueAbi, oilskinAccountAbi, strategyRouterAbi, swapAdapterAbi } from "../src/abi/oilskin.js";
import type { Address } from "../src/types/evm.js";
import { MAX_UINT256 } from "../src/types/evm.js";
import type { MockChain } from "./mockChain.js";
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

  install(accounts: Address[]): void {
    const c = this.chain.contracts;
    c.set(this.opts.router.toLowerCase(), (data) => {
      const { functionName } = decodeFunctionData({ abi: strategyRouterAbi, data });
      if (functionName === "USDC") return encodeFunctionResult({ abi: strategyRouterAbi, functionName, result: this.usdc });
      if (functionName === "LP_VENUE") return encodeFunctionResult({ abi: strategyRouterAbi, functionName, result: this.opts.lpVenue });
      throw revert("mock router: not callable directly");
    });
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
      this.chain.receipts.set(hash.toLowerCase(), { status, blockNumber: this.chain.blockNumber });
      this.chain.txCount.set(from.toLowerCase(), (this.chain.txCount.get(from.toLowerCase()) ?? 0) + 1);
      return hash;
    };
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
    if (p.positionIds.length !== 0) usdcFromLp = this.closeAndSettle(acct, p);

    let repaid = 0n;
    if (p.repayAmount !== 0n) {
      const user = this.chain.users.get(acct)?.get(this.usdc.toLowerCase());
      const owed = user ? user.variableDebt + user.stableDebt : 0n;
      const held = this.usdcBalances.get(acct) ?? 0n;
      let amount = p.repayAmount === MAX_UINT256 ? (owed < held ? owed : held) : p.repayAmount;
      if (amount > held) throw revert("ERC20: transfer amount exceeds balance");
      if (amount > owed) amount = owed;
      if (amount !== 0n && user) {
        user.variableDebt -= amount;
        this.usdcBalances.set(acct, held - amount);
        repaid = amount;
      }
    }
    const [, , , , , hf] = this.chain.accountData(account as Address);
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
  ): bigint {
    if (p.band.minSqrtPriceX96 === 0n || p.band.maxSqrtPriceX96 === 0n || p.band.minSqrtPriceX96 > p.band.maxSqrtPriceX96) {
      throw revertWith(encodeErrorResult({ abi: lpVenueAbi, errorName: "BandRequired" }));
    }
    const list = this.positions.get(acct) ?? [];
    // Pool comes from the first id the account ACTUALLY OWNS (index 0 is not special).
    const first = p.positionIds.map((id) => list.find((x) => x.id === id)).find((x) => x !== undefined);
    if (!first) return 0n; // every id stale: reported as failed, never a revert
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
    return proceeds;
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
    };
  }
  private restore(s: ReturnType<MockOilskin["snapshot"]>) {
    this.positions = s.positions;
    this.usdcBalances = s.usdc;
    this.chain.users = s.users;
  }
}

function revert(message: string): Error & { code: number; data?: Hex } {
  return Object.assign(new Error(`execution reverted: ${message}`), { code: 3 });
}
function revertWith(data: Hex): Error & { code: number; data: Hex } {
  return Object.assign(new Error("execution reverted"), { code: 3, data });
}
