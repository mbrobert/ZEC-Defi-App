/**
 * Execution of a plan, step by step, against a tiny wallet/chain interface
 * (so it can be unit-tested with fakes). Guards for a first-time user run
 * BEFORE every wallet prompt:
 *   • wrong network → refuse (the page already blocks, this is the backstop);
 *   • gas: estimate + balance check, revert reason surfaced in plain words;
 *   • the open step is only built after the permit is signed and the price
 *     band is quoted from the pool's live sqrtPrice at that moment;
 *   • an unwind is only built after a REAL swap quote is fetched and the
 *     enforced floor is read back from the swap adapter. There is no
 *     degradation path: a missing quote is a refusal with a sentence, never a
 *     smaller number (the old `swapMinOut: … : 1n` fallback is gone, and the
 *     chain cannot express it any more either);
 *   • every submitted hash is reported immediately so the page can persist it
 *     (closing the tab does not stop a submitted transaction).
 * Demo mode never reaches this file: SignStep simulates instead.
 */
import type { Address, Hex } from "viem";
import { LP_VENUE_ABI } from "./abi/oilskin";
import { ERC20_ABI } from "./abi/aave";
import { type TokenSymbol } from "@zyo/shared";
import { BASE_TOKENS, CHAIN_ID, PERMIT2 } from "./chain";
import { assessGas, shortenRevert, type GasAssessment, type GasClient } from "./gas";
import {
  encodeClaimWrite,
  encodeGrantWrite,
  encodeOpenWrite,
  encodeRevokeAllWrite,
  encodeUnwindWrite,
  permitTypedData,
  type ClaimPlanInput,
  type Deployment,
  type OpenPlanInput,
  type PermitSig,
  type PlannedCall,
  type QuotedSwap,
  type UnwindPlanInput,
  type WriteSpec,
} from "./plan";
import { QuoteRefused, quoteUnwindSwap } from "./quote";
import type { MarketRead, ReadClient } from "./reads";
import { bandFromSqrtPrice, type PriceBand } from "./tickmath";
import { toAtomic } from "./math";

export interface WalletLike {
  chainId: number | undefined;
  writeContract: (spec: WriteSpec) => Promise<Hex>;
  signTypedData: (td: ReturnType<typeof permitTypedData>) => Promise<Hex>;
  waitForReceipt: (hash: Hex) => Promise<{ status: "success" | "reverted" }>;
}

export type StepEvent =
  | { type: "gas"; step: number; gas: GasAssessment }
  | { type: "blocked"; step: number; reason: string }
  | { type: "signing"; step: number }
  | { type: "submitted"; step: number; hash: Hex }
  | { type: "quoted"; step: number; quote: QuotedSwap }
  | { type: "done"; step: number; hash?: Hex }
  | { type: "failed"; step: number; error: string };

export type Emit = (e: StepEvent) => void;

export interface RunContext {
  wallet: WalletLike;
  read: ReadClient;
  gas: GasClient;
  owner: Address;
  ethPriceUsd: number | null;
  /** Wallet ETH balance reader is inside GasClient; this is the chain's current time source for deadlines. */
  nowSeconds: () => number;
}

function randomNonce(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return BigInt("0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
}

async function guardedWrite(ctx: RunContext, step: number, spec: WriteSpec, emit: Emit): Promise<Hex | null> {
  if (ctx.wallet.chainId !== CHAIN_ID) {
    emit({ type: "blocked", step, reason: `Your wallet is on chain ${ctx.wallet.chainId ?? "?"}; switch it to Base (${CHAIN_ID}) first.` });
    return null;
  }
  let gas: GasAssessment;
  try {
    const [units, price, balance] = await Promise.all([
      ctx.gas.estimateGas({ account: ctx.owner, to: spec.address, data: spec.data }),
      ctx.gas.getGasPrice(),
      ctx.gas.getBalance({ address: ctx.owner }),
    ]);
    gas = assessGas(units, price, balance, ctx.ethPriceUsd);
  } catch (e) {
    emit({ type: "blocked", step, reason: `The network says this transaction would fail, so the wallet was not asked: ${shortenRevert((e as Error).message ?? String(e))}` });
    return null;
  }
  emit({ type: "gas", step, gas });
  if (!gas.ok) {
    emit({ type: "blocked", step, reason: gas.plain });
    return null;
  }
  emit({ type: "signing", step });
  const hash = await ctx.wallet.writeContract(spec);
  emit({ type: "submitted", step, hash });
  const r = await ctx.wallet.waitForReceipt(hash);
  if (r.status !== "success") {
    emit({ type: "failed", step, error: "The transaction was mined but reverted — nothing was changed; the network fee was spent." });
    return null;
  }
  emit({ type: "done", step, hash });
  return hash;
}

/**
 * The LP venue a pool's band is quoted from and a claim is sent to: the engine venue, or the
 * direct Slipstream venue for a pool held there (2026-09-11). A deployment without a direct venue
 * refuses by name rather than quoting the wrong contract.
 */
export function lpVenueFor(d: Deployment, venue: "engine" | "direct" | undefined): Address {
  if (venue === "direct") {
    if (!d.lpVenueDirect) throw new Error("this deployment has no direct Slipstream venue, so a position there cannot be quoted or acted on here");
    return d.lpVenueDirect;
  }
  return d.lpVenue;
}

/** Quote the deposit/close/claim band from the pool's live sqrtPrice, read through its venue. */
export async function quoteBand(read: ReadClient, lpVenue: Address, enginePoolId: `0x${string}`, toleranceBps: number): Promise<PriceBand> {
  const sqrtP = (await read.readContract({ address: lpVenue, abi: LP_VENUE_ABI, functionName: "poolSqrtPriceX96", args: [enginePoolId] })) as bigint;
  if (typeof sqrtP !== "bigint" || sqrtP <= 0n) throw new Error("pool price unreadable — refusing to quote a band");
  return bandFromSqrtPrice(sqrtP, toleranceBps);
}

/**
 * Open flow: approve (if needed) → permit signature → [band quote] → the one
 * transaction (createAccountAndExec / execWithCallback) → optional grant.
 */
export async function runOpen(
  ctx: RunContext,
  input: OpenPlanInput,
  calls: PlannedCall[],
  emit: Emit,
  /** The sized budget lines, or the Error that stopped them being sized (the grant step is then blocked with that reason). */
  grantLimits?: { token: Address; amountPerPeriod: bigint }[] | Error,
): Promise<{ account: Address } | null> {
  const d = input.deployment;
  if (!d || d.demo || !input.predictedAccount) {
    emit({ type: "blocked", step: 1, reason: "No live deployment configured." });
    return null;
  }
  const asset = { address: BASE_TOKENS[input.collateral].address, decimals: BASE_TOKENS[input.collateral].decimals };
  let permit: PermitSig | null = null;

  for (const c of calls) {
    if (!c.required) continue;
    if (c.kind === "approve") {
      const spec: WriteSpec = { address: asset.address, abi: ERC20_ABI, functionName: "approve", args: [PERMIT2, 2n ** 256n - 1n], data: c.data as Hex };
      const hash = await guardedWrite(ctx, c.step, spec, emit);
      if (!hash) return null;
    } else if (c.kind === "permit-signature") {
      const amount = toAtomic(input.collateralAmount, asset.decimals);
      const nonce = randomNonce();
      const deadline = BigInt(input.deadline);
      emit({ type: "signing", step: c.step });
      try {
        const signature = await ctx.wallet.signTypedData(permitTypedData(asset.address, amount, input.predictedAccount, nonce, deadline));
        permit = { nonce, deadline, signature };
        emit({ type: "done", step: c.step });
      } catch (e) {
        emit({ type: "failed", step: c.step, error: shortenRevert((e as Error).message ?? String(e)) });
        return null;
      }
    } else if (c.kind === "open") {
      if (!permit) {
        emit({ type: "blocked", step: c.step, reason: "The permit signature is missing." });
        return null;
      }
      // "hold" runs through StrategyRouter.openBorrowOnly, which takes no band:
      // nothing is deposited into a pool, so there is no pool price to bound.
      let band: PriceBand = { minSqrtPriceX96: 1n, maxSqrtPriceX96: 1n };
      if (input.strategy === "lp") {
        try {
          band = await quoteBand(ctx.read, lpVenueFor(d, input.poolVenue), input.enginePoolId as `0x${string}`, input.bandToleranceBps);
        } catch (e) {
          emit({ type: "blocked", step: c.step, reason: shortenRevert((e as Error).message) });
          return null;
        }
      }
      const spec = encodeOpenWrite(input, permit, band);
      const hash = await guardedWrite(ctx, c.step, spec, emit);
      if (!hash) return null;
    } else if (c.kind === "grant") {
      if (!d.keeper) continue;
      if (grantLimits instanceof Error) {
        emit({ type: "blocked", step: c.step, reason: `The keeper permission was not built: ${grantLimits.message}. Your position is open; you can grant it later from the dashboard.` });
        return null;
      }
      let spec: WriteSpec;
      try {
        spec = encodeGrantWrite({ account: input.predictedAccount, deployment: d, tokenLimits: grantLimits ?? [], nowSeconds: ctx.nowSeconds() });
      } catch (e) {
        emit({ type: "blocked", step: c.step, reason: `The keeper permission could not be built: ${(e as Error).message} Your position is open; you can grant it later from the dashboard.` });
        return null;
      }
      const hash = await guardedWrite(ctx, c.step, spec, emit);
      if (!hash) return null;
    }
  }
  return { account: input.predictedAccount };
}

/**
 * Unwind: fetch a REAL swap quote from the pool (cross-checked against the
 * Aave oracle) and read the floor the adapter will enforce, quote the price
 * band, then one execWithCallback. No quote → no transaction.
 */
export async function runUnwind(
  ctx: RunContext,
  input: Omit<UnwindPlanInput, "quote">,
  position: { enginePoolId: `0x${string}`; poolAddress: Address; venue?: "engine" | "direct" },
  emit: Emit,
  onQuote?: (q: QuotedSwap) => void,
): Promise<Hex | null> {
  const d = input.deployment;
  if (!d || d.demo || !input.account) {
    emit({ type: "blocked", step: 1, reason: "No live deployment configured." });
    return null;
  }
  if (input.withdrawRefusedReason) {
    // RISKS §8 residual (b): a Close withdraws collateral, and a venue whose price is disputed keeps it.
    emit({ type: "blocked", step: 1, reason: `Close is refused while a lending venue's price is disputed — nothing was signed: ${input.withdrawRefusedReason}` });
    return null;
  }
  let quote: QuotedSwap;
  try {
    quote = await quoteUnwindSwap({ read: ctx.read, deployment: d, poolAddress: position.poolAddress, maxSlippageBps: input.bandToleranceBps });
  } catch (e) {
    emit({ type: "blocked", step: 1, reason: e instanceof QuoteRefused ? e.plain : `The swap could not be quoted, so nothing was signed: ${shortenRevert((e as Error).message)}` });
    return null;
  }
  emit({ type: "quoted", step: 1, quote });
  onQuote?.(quote);

  let band: PriceBand;
  try {
    band = await quoteBand(ctx.read, lpVenueFor(d, position.venue), position.enginePoolId, input.bandToleranceBps);
  } catch (e) {
    emit({ type: "blocked", step: 1, reason: shortenRevert((e as Error).message) });
    return null;
  }
  const spec = encodeUnwindWrite({ ...input, quote }, band);
  return guardedWrite(ctx, 1, spec, emit);
}

/** Claim: the engine may compound (and therefore swap), so the claim carries a band and a deadline. */
export async function runClaim(ctx: RunContext, input: ClaimPlanInput, enginePoolId: `0x${string}` | null, emit: Emit): Promise<Hex | null> {
  const d = input.deployment;
  if (!d || d.demo || !input.account) {
    emit({ type: "blocked", step: 1, reason: "No live deployment configured." });
    return null;
  }
  if (!enginePoolId) {
    emit({ type: "blocked", step: 1, reason: "This position's pool could not be identified, so the price limit that protects the reward harvest cannot be set. Nothing was signed." });
    return null;
  }
  let band: PriceBand;
  try {
    band = await quoteBand(ctx.read, lpVenueFor(d, input.venue), enginePoolId, input.bandToleranceBps);
  } catch (e) {
    emit({ type: "blocked", step: 1, reason: shortenRevert((e as Error).message) });
    return null;
  }
  return guardedWrite(ctx, 1, encodeClaimWrite(input, band), emit);
}

/** The kill switch: account.revokeAll() — every grant on the account, gone. */
export async function runRevokeAll(ctx: RunContext, account: Address, emit: Emit): Promise<Hex | null> {
  return guardedWrite(ctx, 1, encodeRevokeAllWrite(account), emit);
}

/** Grant (or renew) the keeper protection on its own, from the dashboard. */
export async function runGrant(
  ctx: RunContext,
  i: { account: Address; deployment: Deployment; tokenLimits: { token: Address; amountPerPeriod: bigint }[] },
  emit: Emit,
): Promise<Hex | null> {
  if (!i.deployment.keeper || i.deployment.demo) {
    emit({ type: "blocked", step: 1, reason: "No Oilskin keeper is configured for this site, so there is nothing to grant." });
    return null;
  }
  let spec: WriteSpec;
  try {
    spec = encodeGrantWrite({ account: i.account, deployment: i.deployment, tokenLimits: i.tokenLimits, nowSeconds: ctx.nowSeconds() });
  } catch (e) {
    emit({ type: "blocked", step: 1, reason: `The keeper permission could not be built: ${(e as Error).message}` });
    return null;
  }
  return guardedWrite(ctx, 1, spec, emit);
}

/** A token the grant must budget, with what is needed to size its line in ITS OWN units. */
export interface GrantTokenPricing {
  address: Address;
  symbol: string;
  decimals: number;
  /** USD per whole token. Non-finite or ≤ 0 = unknown → refused, never a wrong line. */
  priceUsd: number;
}

/**
 * Keeper budget lines for the protection grant — product policy caps, sized
 * from the WHOLE debt, not from the position at sign time: a compounding LP
 * grows, and the keeper sizes its repay against the debt it finds
 * (done-KEEPER §4). The 2× is that headroom plus accrued interest.
 *
 * Every token is sized in ITS OWN decimals at ITS OWN price (audit wave 2,
 * G-HIGH-1): the collateral's number used to be reused for the pool's other
 * token, so a cbBTC user in the WETH/USDC pool signed a WETH budget of
 * ≈ 7.5e-11 WETH and every keeper rung was refused on the swap approve while
 * the panel said "active". A token without a USD price is REFUSED (throws)
 * rather than given a 1-base-unit line that reads as "listed".
 *
 * Every line must be > 0 and unique: the chain refuses an
 * `amountPerPeriod == 0` line and refuses duplicates.
 *
 * These cap DIRECT transfers and approvals the keeper's call tree makes. Value
 * a protocol moves inside that tree (an Aave withdraw, an engine withdrawal)
 * is not bounded by them — the UI says so where it asks for the grant.
 */
export function grantTokenLimits(debtUsdc: number, collateral: GrantTokenPricing, poolTokens: readonly GrantTokenPricing[]): { token: Address; amountPerPeriod: bigint }[] {
  const debt = Math.max(debtUsdc, 0);
  const atLeastOne = (x: bigint) => (x > 0n ? x : 1n);
  const line = (t: GrantTokenPricing): bigint => {
    if (!Number.isFinite(t.priceUsd) || !(t.priceUsd > 0)) {
      throw new Error(`no USD price for ${t.symbol} — its keeper budget cannot be sized; grant the permission later from the dashboard once a price is available`);
    }
    return atLeastOne(BigInt(Math.ceil(((debt * 2) / t.priceUsd) * 10 ** t.decimals)));
  };
  const usdc = atLeastOne(BigInt(Math.ceil(debt * 2 * 10 ** BASE_TOKENS.USDC.decimals))); // repay: whole debt + accrued interest headroom
  const aero = 10n ** 23n; // 100k AERO per day covers any realistic fee transfer
  const lines = [
    { token: BASE_TOKENS.USDC.address as Address, amountPerPeriod: usdc },
    { token: collateral.address, amountPerPeriod: line(collateral) }, // swap of the non-USDC leg when it IS the collateral
    { token: BASE_TOKENS.AERO.address as Address, amountPerPeriod: aero },
  ];
  for (const t of poolTokens) {
    if (lines.some((l) => l.token.toLowerCase() === t.address.toLowerCase())) continue; // USDC, AERO, the collateral: already listed
    lines.push({ token: t.address, amountPerPeriod: line(t) }); // the pool's other leg, in ITS units
  }
  return lines;
}

/**
 * Pricing for a pool's tokens from the market read: USDC is $1 by definition,
 * cbBTC / WETH come from their Aave reserve price, AERO carries no price (its
 * line is fixed and never sized), and any symbol this app does not know is
 * refused by name — the keeper budget for it cannot be sized, so no grant is
 * built rather than a wrong one.
 */
export function grantPoolTokenPricing(symbols: readonly string[], market: MarketRead): GrantTokenPricing[] {
  return symbols.map((sym) => {
    const t = (BASE_TOKENS as Record<string, { address: Address; decimals: number } | undefined>)[sym];
    if (!t) throw new Error(`pool token ${sym} is not a token this app knows (BASE_TOKENS) — refusing to size a keeper budget for it`);
    const priceUsd = sym === "USDC" ? 1 : ((market.reserves as Record<string, { priceUsd: number } | null | undefined>)[sym]?.priceUsd ?? NaN);
    return { address: t.address, symbol: sym as TokenSymbol, decimals: t.decimals, priceUsd };
  });
}

/** Re-export so callers do not need to know where the deployment type lives. */
export type { Deployment };
