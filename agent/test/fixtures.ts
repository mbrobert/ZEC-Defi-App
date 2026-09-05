import { AAVE_V3, BASE_TOKENS, CHAINLINK_FEEDS } from "@zyo/shared";
import { getAddress, type AbiEvent } from "viem";
import { MockChain, type MockReserve } from "./mockChain.js";
import type { Address } from "../src/types/evm.js";
import { reserveSpecsFromShared } from "../src/services/chain.js";
import { accountCreatedEvent } from "../src/abi/oilskin.js";

// viem rejects mixed-case addresses with a bad checksum: checksum the fixtures.
export const FACTORY = getAddress("0xfac70000000000000000000000000000000000ac") as Address;
export const KEEPER = getAddress("0x1111111111111111111111111111111111111111") as Address;
export const OWNER_A = getAddress("0xa000000000000000000000000000000000000001") as Address;
export const OWNER_B = getAddress("0xb000000000000000000000000000000000000002") as Address;
export const ACCOUNT_A = getAddress("0xacc0000000000000000000000000000000000001") as Address;
export const ACCOUNT_B = getAddress("0xacc0000000000000000000000000000000000002") as Address;

export const CBBTC = BASE_TOKENS.cbBTC.address;
export const WETH = BASE_TOKENS.WETH.address;
export const USDC = BASE_TOKENS.USDC.address;

/** Live-ish values from VERIFIED-BASE-FACTS (prices ×1e8, LT in bps). */
export const PRICES = { cbBTC: 79_600_00000000n, WETH: 2_453_45000000n, USDC: 1_00000000n } as const;
export const LTS = { cbBTC: 7800n, WETH: 8300n, USDC: 7800n } as const;

export function mockReserves(nowS: bigint): MockReserve[] {
  const specs = reserveSpecsFromShared();
  return specs.map((s) => {
    const sym = s.symbol as "cbBTC" | "WETH" | "USDC";
    const price = PRICES[sym];
    return {
      symbol: s.symbol,
      asset: s.asset,
      decimals: s.decimals,
      liquidationThresholdBps: LTS[sym],
      isActive: true,
      aavePrice: price,
      feed: s.feed,
      chainlink: s.feed
        ? { roundId: 100n, answer: price, updatedAt: nowS - 60n, answeredInRound: 100n, decimals: 8 }
        : null,
    };
  });
}

export function newMockChain(event: AbiEvent = accountCreatedEvent, nowS?: bigint): MockChain {
  const chain = new MockChain(
    { pool: AAVE_V3.pool, dataProvider: AAVE_V3.poolDataProvider, oracle: AAVE_V3.oracle, factory: FACTORY },
    event
  );
  if (nowS !== undefined) chain.nowS = nowS;
  for (const r of mockReserves(chain.nowS)) chain.addReserve(r);
  return chain;
}

/** A mock chain whose clock is the real clock (for tests that run the real keeper clock). */
export function newLiveClockMockChain(): MockChain {
  return newMockChain(accountCreatedEvent, BigInt(Math.floor(Date.now() / 1000)));
}

/** 1 cbBTC collateral, `usdcDebt` USDC borrowed. HF = 79600×0.78/debt. */
export function cbBtcPosition(chain: MockChain, account: Address, usdcDebt: number): void {
  chain.setPosition(account, {
    collateral: [{ asset: CBBTC, amount: 100_000_000n }],
    debt: [{ asset: USDC, amount: BigInt(Math.round(usdcDebt * 1e6)) }],
  });
}

/** USDC debt (whole units) that puts a 1-cbBTC position at exactly `hf`. */
export function debtForHf(hf: number): number {
  return (79_600 * 0.78) / hf;
}

export { CHAINLINK_FEEDS };
