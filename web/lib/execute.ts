/**
 * Execution of a plan, step by step, against a tiny wallet/chain interface
 * (so it can be unit-tested with fakes). Guards for a first-time user run
 * BEFORE every wallet prompt:
 *   • wrong network → refuse (the page already blocks, this is the backstop);
 *   • gas: estimate + balance check, revert reason surfaced in plain words;
 *   • the open step is only built after the permit is signed and the price
 *     band is quoted from the pool's live sqrtPrice at that moment;
 *   • every submitted hash is reported immediately so the page can persist it
 *     (closing the tab does not stop a submitted transaction).
 * Demo mode never reaches this file: SignStep simulates instead.
 */
import type { Address, Hex } from "viem";
import { AERODROME_CLPOOL_ABI, LP_VENUE_ABI } from "./abi/oilskin";
import { ERC20_ABI } from "./abi/aave";
import { BASE_TOKENS, CHAIN_ID, PERMIT2 } from "@zyo/shared";
import { assessGas, shortenRevert, type GasAssessment, type GasClient } from "./gas";
import {
  encodeClaimWrite,
  encodeGrantWrite,
  encodeOpenWrite,
  encodeUnwindWrite,
  permitTypedData,
  type ClaimPlanInput,
  type OpenPlanInput,
  type PermitSig,
  type PlannedCall,
  type UnwindPlanInput,
  type WriteSpec,
} from "./plan";
import type { ReadClient } from "./reads";
import { bandFromSqrtPrice, usdcShareOfValue, type PriceBand } from "./tickmath";
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

/** Quote the deposit/close band from the engine pool's live sqrtPrice. */
export async function quoteBand(read: ReadClient, lpVenue: Address, enginePoolId: `0x${string}`, toleranceBps: number): Promise<PriceBand> {
  const sqrtP = (await read.readContract({ address: lpVenue, abi: LP_VENUE_ABI, functionName: "poolSqrtPriceX96", args: [enginePoolId] })) as bigint;
  if (typeof sqrtP !== "bigint" || sqrtP <= 0n) throw new Error("pool price unreadable — refusing to quote a band");
  return bandFromSqrtPrice(sqrtP, toleranceBps);
}

/**
 * Open flow: approve (if needed) → permit signature → [band quote] → the one
 * transaction (createAccountAndExec / exec / execBatch) → optional grant.
 */
export async function runOpen(ctx: RunContext, input: OpenPlanInput, calls: PlannedCall[], emit: Emit, grantLimits?: { token: Address; amountPerPeriod: bigint }[]): Promise<{ account: Address } | null> {
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
      let band: PriceBand = { minSqrtPriceX96: 1n, maxSqrtPriceX96: 1n };
      if (input.strategy === "lp") {
        try {
          band = await quoteBand(ctx.read, d.lpVenue, input.enginePoolId as `0x${string}`, input.bandToleranceBps);
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
      const spec = encodeGrantWrite({ account: input.predictedAccount, deployment: d, tokenLimits: grantLimits ?? [], nowSeconds: ctx.nowSeconds() });
      const hash = await guardedWrite(ctx, c.step, spec, emit);
      if (!hash) return null;
    }
  }
  return { account: input.predictedAccount };
}

/**
 * Unwind: read the position's ticks + the pool's tick and tick spacing, size
 * swapMinOut from the non-USDC value share × (1 − tolerance) on the USDC
 * value estimate, quote the band, then one exec.
 */
export async function runUnwind(
  ctx: RunContext,
  input: Omit<UnwindPlanInput, "swapMinOut" | "tickSpacing">,
  position: { enginePoolId: `0x${string}`; tickLower: number; tickUpper: number; poolAddress: Address; usdcIsToken0: boolean; valueUsd: number | null },
  emit: Emit,
): Promise<Hex | null> {
  const d = input.deployment;
  if (!d || d.demo || !input.account) {
    emit({ type: "blocked", step: 1, reason: "No live deployment configured." });
    return null;
  }
  let tickSpacing: number;
  let tick: number;
  try {
    const [slot0, ts] = await Promise.all([
      ctx.read.readContract({ address: position.poolAddress, abi: AERODROME_CLPOOL_ABI, functionName: "slot0" }) as Promise<readonly unknown[]>,
      ctx.read.readContract({ address: position.poolAddress, abi: AERODROME_CLPOOL_ABI, functionName: "tickSpacing" }) as Promise<number>,
    ]);
    tick = Number(slot0[1]);
    tickSpacing = Number(ts);
  } catch (e) {
    emit({ type: "blocked", step: 1, reason: `Could not read the pool: ${shortenRevert((e as Error).message)}` });
    return null;
  }
  if (position.valueUsd === null) {
    emit({ type: "blocked", step: 1, reason: "The position's value is not known yet (indexer cache empty), so the minimum swap output cannot be sized safely. Try again in a minute, or use Advanced mode to enter it yourself." });
    return null;
  }
  const nonUsdcShare = 1 - usdcShareOfValue(tick, position.tickLower, position.tickUpper, position.usdcIsToken0);
  const legUsd = position.valueUsd * nonUsdcShare;
  const minOutUsdc = BigInt(Math.floor(legUsd * (1 - input.bandToleranceBps / 10_000) * 10 ** BASE_TOKENS.USDC.decimals));
  const full: UnwindPlanInput = { ...input, swapMinOut: minOutUsdc > 0n ? minOutUsdc : 1n, tickSpacing };
  let band: PriceBand;
  try {
    band = await quoteBand(ctx.read, d.lpVenue, position.enginePoolId, input.bandToleranceBps);
  } catch (e) {
    emit({ type: "blocked", step: 1, reason: shortenRevert((e as Error).message) });
    return null;
  }
  const spec = encodeUnwindWrite(full, band);
  return guardedWrite(ctx, 1, spec, emit);
}

export async function runClaim(ctx: RunContext, input: ClaimPlanInput, emit: Emit): Promise<Hex | null> {
  const d = input.deployment;
  if (!d || d.demo || !input.account) {
    emit({ type: "blocked", step: 1, reason: "No live deployment configured." });
    return null;
  }
  return guardedWrite(ctx, 1, encodeClaimWrite(input), emit);
}

/** Keeper budget lines for the protection grant — product policy caps, sized from the position. */
export function grantTokenLimits(borrowUsdc: number, collateral: { address: Address; decimals: number; priceUsd: number }, poolTokens: Address[]): { token: Address; amountPerPeriod: bigint }[] {
  const usdc = BigInt(Math.ceil(borrowUsdc * 2 * 10 ** BASE_TOKENS.USDC.decimals)); // repay: debt + accrued interest headroom
  const coll = BigInt(Math.ceil(((borrowUsdc * 2) / collateral.priceUsd) * 10 ** collateral.decimals)); // swap approval of the non-USDC leg
  const aero = 10n ** 23n; // 100k AERO per day covers any realistic fee transfer
  const lines = [
    { token: BASE_TOKENS.USDC.address, amountPerPeriod: usdc },
    { token: collateral.address, amountPerPeriod: coll },
    { token: BASE_TOKENS.AERO.address, amountPerPeriod: aero },
  ];
  for (const t of poolTokens) {
    if (!lines.some((l) => l.token.toLowerCase() === t.toLowerCase())) lines.push({ token: t, amountPerPeriod: coll });
  }
  return lines;
}

