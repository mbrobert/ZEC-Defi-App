import {
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
} from "viem";
import { erc20BalanceAbi, lpVenueAbi, oilskinAccountAbi, strategyRouterAbi } from "../src/abi/oilskin.js";
import type { Address } from "../src/types/evm.js";
import { MAX_UINT256 } from "../src/types/evm.js";
import type { MockChain } from "./mockChain.js";
import { USDC } from "./fixtures.js";

/**
 * Behavioural mock of OilskinAccount + StrategyRouter + SnuggleLpVenue on top
 * of MockChain. `eth_call` simulations validate without mutating; signed raw
 * transactions (eth_sendRawTransaction) are decoded, sender-recovered, executed
 * against the mock state (positions closed, USDC credited, Aave debt repaid)
 * and given a receipt. Reverts carry real ABI-encoded error data so viem
 * decodes the error name exactly as it would on Base.
 */
export interface MockOilskinOptions {
  router: Address;
  lpVenue: Address;
  usdc?: Address;
}

export class MockOilskin {
  readonly usdc: Address;
  /** `${keeper}:${target}:${selector}` (lowercase) → active */
  grants = new Map<string, boolean>();
  positions = new Map<string, { id: bigint; poolId: Hex }[]>();
  poolPrices = new Map<Hex, bigint>();
  usdcBalances = new Map<string, bigint>();
  /** USDC credited to the account when `id` closes (default 1,000 USDC). */
  closeYieldUsdc = new Map<bigint, bigint>();
  defaultCloseYield = 1_000_000_000n;
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

  grant(keeper: Address, target: Address, selector: Hex): void {
    this.grants.set(`${keeper}:${target}:${selector}`.toLowerCase(), true);
  }
  revoke(keeper: Address, target: Address, selector: Hex): void {
    this.grants.delete(`${keeper}:${target}:${selector}`.toLowerCase());
  }
  setPositions(account: Address, list: { id: bigint; poolId: Hex }[]): void {
    this.positions.set(account.toLowerCase(), [...list]);
  }
  setUsdc(account: Address, amount: bigint): void {
    this.usdcBalances.set(account.toLowerCase(), amount);
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
      throw revert("mock venue: not callable directly");
    });
    c.set(this.usdc.toLowerCase(), (data) => {
      const { functionName, args } = decodeFunctionData({ abi: erc20BalanceAbi, data });
      if (functionName === "balanceOf") {
        const [acct] = args as [Address];
        return encodeFunctionResult({ abi: erc20BalanceAbi, functionName, result: this.usdcBalances.get(acct.toLowerCase()) ?? 0n });
      }
      throw revert("mock usdc");
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

  private accountCall(account: Address, data: Hex, from: Address | undefined, mutate: boolean): Hex {
    const { functionName, args } = decodeFunctionData({ abi: oilskinAccountAbi, data });
    if (functionName === "grantOf") {
      const [keeper, target, selector] = args as [Address, Address, Hex];
      const active = this.grants.get(`${keeper}:${target}:${selector}`.toLowerCase()) === true;
      return encodeFunctionResult({ abi: oilskinAccountAbi, functionName, result: [active, 0n, 0n, 86400, 4102444800, 0] });
    }
    if (functionName === "execAsKeeper") {
      const [calls] = args as [{ target: Address; value: bigint; data: Hex }[]];
      const keeper = (from ?? "0x0000000000000000000000000000000000000000") as Address;
      const rec = { account, from: keeper, calls: [] as { target: Address; selector: Hex }[], mutate };
      const results: Hex[] = [];
      // Snapshot so a dry run never mutates.
      const snap = mutate ? null : this.snapshot();
      try {
        for (const call of calls) {
          const selector = call.data.slice(0, 10) as Hex;
          rec.calls.push({ target: call.target, selector });
          if (!this.grants.get(`${keeper}:${call.target}:${selector}`.toLowerCase())) {
            throw revertWith(encodeErrorResult({ abi: oilskinAccountAbi, errorName: "NotGranted", args: [keeper, call.target, selector] }));
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
    if (target.toLowerCase() === this.opts.lpVenue.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: lpVenueAbi, data });
      if (functionName !== "closeMany") throw revert("mock venue: only closeMany");
      const [ids, band] = args as [readonly bigint[], { minSqrtPriceX96: bigint; maxSqrtPriceX96: bigint }];
      if (band.minSqrtPriceX96 === 0n || band.maxSqrtPriceX96 === 0n || band.minSqrtPriceX96 > band.maxSqrtPriceX96) {
        throw revertWith(encodeErrorResult({ abi: lpVenueAbi, errorName: "BandRequired" }));
      }
      const list = this.positions.get(acct) ?? [];
      let out1 = 0n;
      for (const id of ids) {
        const p = list.find((x) => x.id === id);
        if (!p) throw revert(`mock venue: ${id} not owned`);
        const price = this.poolPrices.get(p.poolId) ?? 0n;
        if (price < band.minSqrtPriceX96 || price > band.maxSqrtPriceX96) {
          throw revertWith(encodeErrorResult({ abi: lpVenueAbi, errorName: "PriceOutOfBand", args: [price, band.minSqrtPriceX96, band.maxSqrtPriceX96] }));
        }
        const yieldUsdc = this.closeYieldUsdc.get(id) ?? this.defaultCloseYield;
        out1 += yieldUsdc;
        this.usdcBalances.set(acct, (this.usdcBalances.get(acct) ?? 0n) + yieldUsdc);
      }
      this.positions.set(acct, list.filter((x) => !ids.includes(x.id)));
      return encodeFunctionResult({ abi: lpVenueAbi, functionName, result: [0n, out1, 0n, []] });
    }
    if (target.toLowerCase() === this.opts.router.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: strategyRouterAbi, data });
      if (functionName !== "unwind") throw revert("mock router: only unwind");
      const [p] = args as unknown as [{ positionIds: readonly bigint[]; repayAmount: bigint; withdrawAmount: bigint; deadline: bigint }];
      if (p.deadline < this.chain.nowS) throw revertWith(encodeErrorResult({ abi: strategyRouterAbi, errorName: "Expired", args: [p.deadline] }));
      if (p.positionIds.length !== 0) throw revert("mock router: keeper must not pass positionIds");
      if (p.withdrawAmount !== 0n) throw revert("mock router: keeper must not withdraw");
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
      const [, , , , , hf] = this.chain.accountData(account);
      return encodeFunctionResult({ abi: strategyRouterAbi, functionName, result: [0n, repaid, 0n, hf] });
    }
    throw revert(`mock: unknown root target ${target}`);
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
