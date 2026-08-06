import { INTENTS_ASSET_IDS } from "@zyo/shared";
import type { Address, Hex } from "../types/evm.js";
import { decideReward, type RewardDecisionInput } from "../engine/rewardDecision.js";
import {
  computeQuoteHash,
  type OneClickClient,
  type QuoteRequest,
} from "../services/oneClick.js";
import type { ChainService, OnchainPosition } from "../services/chain.js";

export interface RewardPolicy {
  minCostMultiple: number;
  minAbsoluteUsd: number;
  maxHoldDays: number;
  /** Slippage for the reward → ZEC intent, bps. */
  slippageToleranceBps: number;
  /** Quote deadline horizon, minutes. */
  quoteDeadlineMinutes: number;
}

export interface RewardContext {
  positionId: bigint;
  position: OnchainPosition;
  accruedUsd: number;
  gasUsd: number;
  bridgeFeeUsd: number;
  accrualAgeDays: number;
  /** Atomic amount of the position token expected to be claimed. */
  accruedAtomic: bigint;
  /** Intents asset id for the position token (e.g. USDC on Base). */
  originAssetId: string;
  /** Address refunds should land on if the intent fails (the vault). */
  refundAddress: Address;
}

export type RewardOutcome =
  | { kind: "WAITED"; reason: string }
  | { kind: "COMPOUNDED"; txHash: Hex }
  | {
      kind: "ROUTED_TO_ZCASH";
      txHash: Hex;
      depositAddress: string;
      quoteHash: Hex;
      expectedZecOut: string;
    };

export class QuoteSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteSafetyError";
  }
}

/**
 * Executes the user's reward preference once the decision engine says CLAIM.
 *
 * SEND_TO_ZCASH safety invariants (enforced here, audited via events):
 *   1. The 1-Click quote's recipient MUST equal the position's stored Zcash
 *      address, and the destination asset MUST be native ZEC.
 *   2. The on-chain transfer target is exactly the quote's depositAddress.
 *   3. The emitted quoteHash binds the tx to the quote for offline audit.
 */
export class RewardExecutor {
  constructor(
    private readonly chain: ChainService,
    private readonly oneClick: OneClickClient,
    private readonly policy: RewardPolicy
  ) {}

  async execute(ctx: RewardContext): Promise<RewardOutcome> {
    const isZcashRoute = ctx.position.rewardPref === 1;
    const decisionInput: RewardDecisionInput = {
      accruedUsd: ctx.accruedUsd,
      gasUsd: ctx.gasUsd,
      bridgeFeeUsd: isZcashRoute ? ctx.bridgeFeeUsd : 0,
      minCostMultiple: this.policy.minCostMultiple,
      minAbsoluteUsd: this.policy.minAbsoluteUsd,
      accrualAgeDays: ctx.accrualAgeDays,
      maxHoldDays: this.policy.maxHoldDays,
    };
    const decision = decideReward(decisionInput);
    if (decision.action === "WAIT") {
      return { kind: "WAITED", reason: decision.reason };
    }

    if (!isZcashRoute) {
      const txHash = await this.chain.compound(ctx.positionId);
      return { kind: "COMPOUNDED", txHash };
    }

    return this.routeToZcash(ctx);
  }

  private async routeToZcash(ctx: RewardContext): Promise<RewardOutcome> {
    const zcashAddress = ctx.position.zcashAddress;
    if (!zcashAddress) {
      throw new QuoteSafetyError("position has SEND_TO_ZCASH pref but no zcash address");
    }

    const deadline = new Date(
      Date.now() + this.policy.quoteDeadlineMinutes * 60_000
    ).toISOString();

    const request: QuoteRequest = {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: this.policy.slippageToleranceBps,
      originAsset: ctx.originAssetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: INTENTS_ASSET_IDS.ZEC,
      amount: ctx.accruedAtomic.toString(),
      refundTo: ctx.refundAddress,
      refundType: "ORIGIN_CHAIN",
      recipient: zcashAddress,
      recipientType: "DESTINATION_CHAIN",
      deadline,
    };

    const quote = await this.oneClick.getQuote(request);

    // ---- safety invariant #1: the quote must deliver ZEC to the user's addr
    if (quote.quoteRequest.recipient !== zcashAddress) {
      throw new QuoteSafetyError(
        `quote recipient ${quote.quoteRequest.recipient} != position zcash address ${zcashAddress}`
      );
    }
    if (quote.quoteRequest.destinationAsset !== INTENTS_ASSET_IDS.ZEC) {
      throw new QuoteSafetyError(
        `quote destination ${quote.quoteRequest.destinationAsset} is not native ZEC`
      );
    }
    const depositAddress = quote.quote.depositAddress;
    if (!depositAddress || !/^0x[0-9a-fA-F]{40}$/.test(depositAddress)) {
      throw new QuoteSafetyError(`quote deposit address invalid: ${depositAddress}`);
    }

    const quoteHash = computeQuoteHash(quote);

    // ---- safety invariant #2: transfer goes to the quoted deposit address
    const txHash = await this.chain.routeToZcash(
      ctx.positionId,
      depositAddress as Address,
      quoteHash
    );

    // Nudge the solver network; delivery is tracked by the status poller.
    await this.oneClick.submitDepositTx(depositAddress, txHash).catch((e) => {
      console.warn("[reward] deposit/submit failed (solver will still detect):", e.message);
    });

    return {
      kind: "ROUTED_TO_ZCASH",
      txHash,
      depositAddress,
      quoteHash,
      expectedZecOut: quote.quote.amountOut,
    };
  }
}
