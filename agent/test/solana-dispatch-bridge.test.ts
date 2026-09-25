/**
 * The Solana dispatcher's bridge route, driven end to end with fakes for everything outside the dispatcher
 * (AUDIT-2026-09-25 CC-2 and CC-3): a linked pair whose rung the Base leg cannot answer must be answered on
 * Solana THIS tick — the reserve, then the keeper-funded sale, inside the Solana grant — not left as a record
 * that retries the same refusal until the attempt cap; a FAILED Base send is left for the receipt, because it
 * may have gone out; and a rung the owner excluded on the Solana grant is not taken on Base either, because the
 * Base grant has no rung mask and the Solana one is the owner's only per-rung consent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { evmAddressToBytes32 } from "@zyo/shared";
import type { BurnResult } from "../src/dispatch/types.js";
import { Logger, memorySink } from "../src/log.js";
import { KeeperSolanaDispatcher, type BaseBurner, type SolanaDispatchRecord } from "../src/solana/dispatcher.js";
import { OILSKIN_ERRORS, PK, SF_ONE, obligationPda, type GrantView, type ObligationView, type ReserveView, type ScopeEntry, type UserAccountView } from "../src/solana/layouts.js";
import { expectedRecipientOf, type PairReader, type PairView } from "../src/solana/pair.js";
import type { SolanaReader } from "../src/solana/reader.js";
import type { SolanaSnapshot } from "../src/solana/valuation.js";

const BASE = "0x1646587E543bC2f63137bAa86F8598E1274aED78" as const;
const BURN_TX = ("0x" + "ab".repeat(32)) as `0x${string}`;
const ONE_ZEC = 100_000_000n;
const ONE_USDC = 1_000_000n;
const LT = 0.65;
const usdSf = (usd: number): bigint => (BigInt(Math.round(usd * 1e9)) * SF_ONE) / 1_000_000_000n;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SIG = B58[7]!.repeat(88);

/** One position at the price given: 10 ZEC, a debt that puts it in the de-risk band, no idle USDC. */
function world(opts: { zecUsd?: number; debtUsdc?: bigint; idleUsdc?: bigint; allowedRungs?: number; keeperUsdc?: bigint } = {}) {
  const zecUsd = opts.zecUsd ?? 1000;
  const collateralZec = 10n * ONE_ZEC;
  const debtUsdc = opts.debtUsdc ?? 5_909n * ONE_USDC; // HF = 6,500 / 5,909 ≈ 1.10 — under the de-risk rung (1.11), above the emergency (1.07)
  const idleUsdc = opts.idleUsdc ?? 0n;
  const slot = 447_000_000n;
  const nowS = 1_789_000_000n;
  const account = Keypair.generate().publicKey;
  const keeper = Keypair.generate();
  const view: UserAccountView = { owner: Keypair.generate().publicKey, bump: 255, version: 1, grantEpoch: 0n, obligation: obligationPda(account), createdSlot: slot, entryHfBps: 0n, baseAccount: evmAddressToBytes32(BASE) };
  const reserve = (zec: boolean): ReserveView => {
    const supply = 1_000_000n * (zec ? ONE_ZEC : ONE_USDC);
    return { slot, stale: false, priceStatus: 63, status: 0, loanToValuePct: 40, liquidationThresholdPct: 65, borrowFactorPct: 100n, liquidityMint: zec ? PK.zecMint : PK.usdcMint, liquidityAvailable: supply, liquidityBorrowedSf: 0n, marketPriceSf: usdSf(zec ? zecUsd : 1), mintDecimals: zec ? 8 : 6, collateralTotalSupply: supply, maxAgePriceSeconds: 180n, scopePriceFeed: PK.scopePrices, scopePriceChain0: zec ? 430 : 13 };
  };
  const collateralUsd = (Number(collateralZec) / 1e8) * zecUsd;
  const debtUsd = Number(debtUsdc) / 1e6;
  const obligation: ObligationView = { slot, stale: false, priceStatus: 63, owner: account, lendingMarket: PK.market, depositReserves: [PK.zecReserve], borrowReserves: [PK.usdcReserve], zecDepositedCtokens: collateralZec, usdcBorrowedAmountSf: debtUsdc * SF_ONE, depositedValueSf: usdSf(collateralUsd), borrowFactorAdjustedDebtValueSf: usdSf(debtUsd), borrowedAssetsMarketValueSf: usdSf(debtUsd), allowedBorrowValueSf: usdSf(collateralUsd * 0.4), unhealthyBorrowValueSf: usdSf(collateralUsd * LT), hasDebt: true };
  const scope = (index: number, priceUsd: number): ScopeEntry => ({ index, value: BigInt(Math.round(priceUsd * 1e8)), exp: 8, lastUpdatedSlot: slot, unixTimestamp: nowS, priceUsd });
  const snapshot: SolanaSnapshot = { slot, nowS, obligation, zecReserve: reserve(true), usdcReserve: reserve(false), scopeZec: scope(430, zecUsd), scopeUsdc: scope(13, 1), independent: null, accountUsdc: idleUsdc, accountZec: 0n };
  const grant: GrantView = { account, keeper: keeper.publicKey, version: 1, epoch: 0n, expiryTs: nowS + 86_400n, periodSecs: 86_400n, periodStartTs: nowS, repayUsdcPerPeriod: 10_000n * ONE_USDC, repayUsdcSpent: 0n, sellZecPerPeriod: 10n * ONE_ZEC, sellZecSpent: 0n, maxSellSlippageBps: 200, allowedRungs: opts.allowedRungs ?? 0b1111 };
  const reader = {
    discover: async () => [{ account, view }],
    snapshot: async () => snapshot,
    readGrant: async () => grant,
    tokenBalance: async () => opts.keeperUsdc ?? 5_000n * ONE_USDC,
  } as unknown as SolanaReader;
  const pairView: PairView = { baseAccount: BASE, recipientOnBase: expectedRecipientOf(account), expectedRecipient: expectedRecipientOf(account), status: "linked" };
  const pair: PairReader = { read: async () => pairView };
  const sent: Uint8Array[] = [];
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
    sendRawTransaction: async (raw: Uint8Array) => {
      sent.push(raw);
      return SIG;
    },
    confirmTransaction: async () => ({ value: { err: null } }),
    getAccountInfo: async () => null,
  } as never;
  return { account, keeper, view, snapshot, grant, reader, pair, sent, connection, nowS };
}

function record(account: PublicKey, over: Partial<SolanaDispatchRecord> = {}): SolanaDispatchRecord {
  const now = "2026-09-25T22:00:00.000Z";
  return { key: `${account.toBase58()}:1:1:derisk`, account: account.toBase58(), episode: 1, seq: 1, action: "derisk", rung: "derisk", hf: 1.1, status: "PENDING", attempts: 0, createdAt: now, updatedAt: now, ...over };
}

function rig(w: ReturnType<typeof world>, burnerScript: (input: Parameters<BaseBurner["dispatch"]>[0]) => BurnResult) {
  const sink = memorySink();
  const burnerCalls: Parameters<BaseBurner["dispatch"]>[0][] = [];
  const burner: BaseBurner = {
    dispatch: async (input) => {
      burnerCalls.push(input);
      return burnerScript(input);
    },
    confirm: async () => ({ status: "FAILED", error: "not used here" }),
  };
  const d = new KeeperSolanaDispatcher({
    connection: w.connection,
    reader: w.reader,
    programId: Keypair.generate().publicKey,
    keeper: w.keeper,
    rungs: [{ id: 0, disarmHf: 1.25 }, { id: 1, disarmHf: 1.18 }, { id: 2, disarmHf: 1.11 }, { id: 3, disarmHf: 1.07 }],
    rungIndex: () => 2,
    valuationParams: { priceMaxAgeS: 180, independentMaxAgeS: 120, oracleDeviationBps: 200, hfToleranceBps: 100, requireIndependent: false },
    saleDiscountBps: 0,
    keeperMaxSaleUsdc: 5_000n * ONE_USDC,
    planMarginBps: 50,
    confirmTimeoutMs: 2_000,
    idlErrors: OILSKIN_ERRORS,
    log: new Logger(sink.sink, "debug"),
    pair: w.pair,
    baseBurner: burner,
    attestation: null,
    bridgeStallS: 1800,
  });
  return { d, burnerCalls, lines: sink.lines as string[] };
}

describe("the Solana dispatcher's bridge route", () => {
  it("a linked pair below the de-risk rung with no idle USDC goes to the Base leg, with the burn action named and the pre-burn write forwarded; a SENT burn comes back as the bridge record", async () => {
    const w = world();
    const r = rig(w, () => ({ status: "SENT", txHash: BURN_TX, bridge: { chain: "base", stage: "burn-sent", burnTxHash: BURN_TX, amountUsdc: "0", baseAccount: BASE } }));
    const persisted: unknown[] = [];
    const out = await r.d.dispatch({ record: record(w.account), inFlightAgeS: null, persistBeforeBurn: async (info) => { persisted.push(info); } });
    assert.equal(out.status, "SENT", JSON.stringify(out));
    if (out.status !== "SENT") return;
    assert.equal(out.signature, BURN_TX, "the Base hash rides in the signature");
    assert.equal(out.bridge?.stage, "burn-sent");
    assert.equal(r.burnerCalls.length, 1);
    assert.equal(r.burnerCalls[0]!.action, "burn-derisk");
    assert.equal(r.burnerCalls[0]!.baseAccount, BASE);
    assert.ok(r.burnerCalls[0]!.usdcNeeded > 0n, "the need the Solana valuation computed");
    assert.equal(typeof r.burnerCalls[0]!.persistBeforeSend, "function", "the monitor's pre-burn write reaches the Base dispatcher");
    assert.equal(w.sent.length, 0, "nothing was sent on Solana");
  });

  it("CC-2: a REFUSED Base leg is answered on Solana THIS tick — the keeper-funded sale inside the Solana grant — and the result says so", async () => {
    const w = world();
    const r = rig(w, () => ({ status: "REFUSED", permanent: true, reason: "no active grant for keeper on the router selector closeLpAndBurn" }));
    const out = await r.d.dispatch({ record: record(w.account), inFlightAgeS: null });
    assert.equal(out.status, "CONFIRMED", JSON.stringify(out));
    if (out.status !== "CONFIRMED") return;
    assert.match(out.signature, /^[1-9A-HJ-NP-Za-km-z]{86,88}$/, "a Solana signature — the dispatcher's own, of the transaction it signed — not a Base hash");
    assert.notEqual(out.signature, BURN_TX);
    assert.match(out.note ?? "", /Base leg refused \(permanent — the owner must act\): no active grant/);
    assert.match(out.note ?? "", /answered on Solana/);
    assert.equal(w.sent.length, 1, "one Solana transaction");
    assert.ok(r.lines.some((l) => /the Base leg refused — the single-chain path answers this rung/.test(l)), r.lines.join("\n"));
    // a transient refusal is treated the same way this tick — the reserve is what stands in for the bridge
    const w2 = world();
    const r2 = rig(w2, () => ({ status: "REFUSED", reason: "cannot read LP state (fail closed): rpc timeout" }));
    const out2 = await r2.d.dispatch({ record: record(w2.account), inFlightAgeS: null });
    assert.equal(out2.status, "CONFIRMED", JSON.stringify(out2));
    if (out2.status === "CONFIRMED") assert.match(out2.note ?? "", /^Base leg refused: cannot read LP state/);
  });

  it("CC-2: when the Solana path cannot act either, the refusal names both legs, in order", async () => {
    // a repay-only grant (no sale) and no idle USDC: the Base leg refuses, the Solana plan refuses
    const w = world();
    w.grant.sellZecPerPeriod = 0n;
    const r = rig(w, () => ({ status: "REFUSED", reason: "the router records another recipient" , permanent: true }));
    const out = await r.d.dispatch({ record: record(w.account), inFlightAgeS: null });
    assert.equal(out.status, "REFUSED", JSON.stringify(out));
    if (out.status !== "REFUSED") return;
    assert.match(out.reason, /^Base leg refused \(permanent — the owner must act\): the router records another recipient; then on Solana: the grant allows no sale/);
    assert.equal(out.permanent, false, "the Solana refusal's own permanence decides the record's fate — the owner can still add USDC");
    assert.equal(w.sent.length, 0);
  });

  it("a FAILED Base send is NOT answered on Solana — it may have gone out, and the persisted nonce and the receipt settle it first", async () => {
    const w = world();
    const r = rig(w, () => ({ status: "FAILED", error: "send failed: nonce too low" }));
    const out = await r.d.dispatch({ record: record(w.account), inFlightAgeS: null });
    assert.equal(out.status, "FAILED");
    if (out.status === "FAILED") assert.match(out.error, /^Base burn: send failed/);
    assert.equal(w.sent.length, 0, "no Solana transaction while a Base send is unaccounted for");
  });

  it("CC-3: a rung the owner excluded on the Solana grant is not taken on Base either — REFUSED permanently, by name, before the Base leg is asked", async () => {
    const w = world({ allowedRungs: 0b0011 }); // warn and repay only
    const r = rig(w, () => ({ status: "SENT", txHash: BURN_TX, bridge: { chain: "base", stage: "burn-sent", burnTxHash: BURN_TX, amountUsdc: "0" } }));
    const out = await r.d.dispatch({ record: record(w.account), inFlightAgeS: null });
    assert.equal(out.status, "REFUSED", JSON.stringify(out));
    if (out.status !== "REFUSED") return;
    assert.equal(out.permanent, true);
    assert.match(out.reason, /rung 2 not allowed by the grant — the Base leg is not taken/);
    assert.equal(r.burnerCalls.length, 0, "the Base leg was never asked");
    assert.equal(w.sent.length, 0);
  });

  it("a burn already in flight inside the stall window is a WAIT, not a second burn and not a sale", async () => {
    const w = world();
    const r = rig(w, () => ({ status: "SENT", txHash: BURN_TX, bridge: { chain: "base", stage: "burn-sent", burnTxHash: BURN_TX, amountUsdc: "0" } }));
    const out = await r.d.dispatch({ record: record(w.account), inFlightAgeS: 120 });
    assert.equal(out.status, "REFUSED");
    if (out.status === "REFUSED") {
      assert.match(out.reason, /a Base burn is in flight \(120 s old; stall window 1800 s\)/);
      assert.equal(out.permanent, undefined);
    }
    assert.equal(r.burnerCalls.length, 0);
    assert.equal(w.sent.length, 0);
  });
});
