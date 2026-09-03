import type { BorrowAssetSymbol } from "@zyo/shared";
import { INTENTS_ASSET_IDS } from "@zyo/shared";
import type { BorrowRequest, RheaAccountState, RheaService } from "./rhea.js";

/**
 * RheaService implementation over the REAL @rhea-finance/cross-chain-sdk
 * (v0.1.20 — API extracted from the published package; docs/RHEA-SDK.md).
 *
 * The SDK is loaded dynamically so the zero-dependency build/tests never need
 * it installed; on a machine where `npm i @rhea-finance/cross-chain-sdk` has
 * run (e.g. Matt's), this service becomes fully live for the read + deposit
 * paths. Mutations that require the MCA identity wallet to sign
 * (borrow/repay/withdraw via relayer) are wired up to the exact SDK call
 * sequence and stop at the signing seam with a precise error until the
 * operator signing key is configured.
 */

type Sdk = typeof import("@rhea-finance/cross-chain-sdk");

/** Burrow token ids for our curated borrow assets (NEAR side). */
const BORROW_TOKEN_IDS: Record<BorrowAssetSymbol, { tokenId: string; intentsAssetId: string }> = {
  // FINALIZE: confirm exact Burrow token ids against getAssets() on first live run.
  USDC: {
    tokenId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    intentsAssetId: INTENTS_ASSET_IDS.USDC_NEAR,
  },
  cbBTC: { tokenId: "cbbtc.omft.near", intentsAssetId: INTENTS_ASSET_IDS.CBBTC_BASE },
  WETH: { tokenId: "eth.omft.near", intentsAssetId: INTENTS_ASSET_IDS.WETH_BASE },
};

const DEST_ASSET_ON_BASE: Record<BorrowAssetSymbol, string> = {
  USDC: INTENTS_ASSET_IDS.USDC_BASE,
  cbBTC: INTENTS_ASSET_IDS.CBBTC_BASE,
  WETH: INTENTS_ASSET_IDS.WETH_BASE,
};

export class RheaSdkService implements RheaService {
  private constructor(private readonly sdk: Sdk) {}

  static async create(networkId: "mainnet" | "testnet"): Promise<RheaSdkService> {
    let sdk: Sdk;
    try {
      sdk = (await (Function(
        'return import("@rhea-finance/cross-chain-sdk")'
      )() as Promise<Sdk>)) as Sdk;
    } catch {
      throw new Error(
        "@rhea-finance/cross-chain-sdk is not installed. " +
          "`npm i @rhea-finance/cross-chain-sdk -w @zyo/agent` on a networked machine, " +
          "or run with RHEA_MODE=mock. See docs/RHEA-SDK.md."
      );
    }
    if (networkId === "testnet") sdk.setSdkEnv?.("testnet");
    return new RheaSdkService(sdk);
  }

  /**
   * Resolve (or create) the user's Multi-Chain Account keyed by their wallet
   * identity, and hand back the Zcash-native deposit address for funding it.
   */
  async ensureAccount(userKey: string): Promise<{ mcaId: string; zecDepositAddress: string }> {
    const existing = await this.sdk.getMcaByWallet({ chain: "evm", identityKey: userKey });
    const mcaId: string | undefined =
      existing?.mca ?? existing?.mcaId ?? (typeof existing === "string" ? existing : undefined);
    if (mcaId) {
      const zecDepositAddress = await this.sdk.getZcashCreateMcaDepositAddress(mcaId);
      return { mcaId, zecDepositAddress };
    }
    // MCA creation needs the user's wallet to sign the identity binding:
    //   format_wallet → serializationObj → prepare_sign_message_evm →
    //   <user signs> → process_signature_evm → getCreateMcaCustomRecipientMsg
    //   → getCreateMcaFeeData → intentsQuotation → fund deposit address.
    // That signature must come from the UI (user's wallet), not the agent.
    throw new Error(
      `No MCA found for ${userKey}. MCA creation requires a user wallet signature — ` +
        "initiate it from the web app (see docs/RHEA-SDK.md, 'Create MCA')."
    );
  }

  /** Intent-based native ZEC supply: returns after quoting; the user funds it. */
  async supplyZec(mcaId: string): Promise<{ txId: string }> {
    const w = this.sdk.format_wallet({ chain: "near", identityKey: mcaId });
    const customRecipientMsg = this.sdk.getSupplyCustomRecipientMsg({
      useAsCollateral: true,
      w,
    });
    const quote = await this.sdk.intentsQuotation({
      recipient: mcaId,
      customRecipientMsg,
      originAsset: INTENTS_ASSET_IDS.ZEC,
    });
    const depositAddress = quote?.quoteSuccessResult?.quote?.depositAddress;
    if (!depositAddress) throw new Error("intentsQuotation returned no deposit address");
    // Supply completes when ZEC arrives at depositAddress; solver handles the rest.
    return { txId: `intents:${depositAddress}` };
  }

  async getAccountState(mcaId: string): Promise<RheaAccountState> {
    const [portfolio, assets, prices] = await Promise.all([
      this.sdk.getAccountAllPositions(mcaId),
      this.sdk.getAssets(),
      this.sdk.getPrices(),
    ]);

    // Health factor: the SDK exposes per-op recompute helpers; the portfolio
    // itself carries supplied/borrowed with prices — reduce to our shape.
    const state = mapPortfolioToState(mcaId, portfolio, assets, prices);
    return state;
  }

  /** Borrow with cross-chain delivery to the Base vault. */
  async borrow(req: BorrowRequest): Promise<{ txId: string }> {
    const ids = BORROW_TOKEN_IDS[req.asset];
    const [assets, portfolio, config] = await Promise.all([
      this.sdk.getAssets(),
      this.sdk.getAccountAllPositions(req.mcaId),
      this.sdk.getConfig(),
    ]);
    const simpleWithdrawData = this.sdk.computeRelayerGas({
      nearStorageAmount: undefined,
      mca: req.mcaId,
      relayerGasFees: undefined,
      assets,
      portfolio,
    });
    const { businessMap, quoteResult } = await this.sdk.prepareBusinessDataOnBorrow({
      mca: req.mcaId,
      recipient: req.deliverTo.address, // ← the PositionVault on Base
      tokenId: ids.tokenId,
      originAsset: `nep141:${ids.tokenId}`,
      destinationAsset: DEST_ASSET_ON_BASE[req.asset],
      amountBurrow: req.amountAtomic,
      amountToken: req.amountAtomic,
      config,
      simpleWithdrawData,
    });
    void businessMap;
    void quoteResult;
    // Remaining seam: sign businessMap with the MCA identity key
    // (prepare_sign_message_evm → sign → process_signature_evm) and
    // submitSignedTransactionToRelayer. Requires OPERATOR_NEAR_IDENTITY key
    // bound to the MCA as an authorized wallet.
    throw new Error(
      "borrow(): business data prepared — signing seam not configured. " +
        "Bind the operator identity wallet to the MCA and wire " +
        "submitSignedTransactionToRelayer (docs/RHEA-SDK.md §Integration notes)."
    );
  }

  async repay(): Promise<{ txId: string }> {
    throw new Error("repay(): wire prepareBusinessDataOnRepayFromSupplied + relayer (RHEA-SDK.md)");
  }

  async withdrawZec(): Promise<{ txId: string }> {
    throw new Error("withdrawZec(): wire prepareBusinessDataOnWithdraw + relayer (RHEA-SDK.md)");
  }
}

/** Exported for unit testing with fixture portfolios. */
export function mapPortfolioToState(
  mcaId: string,
  portfolio: any,
  assets: any,
  prices: any
): RheaAccountState {
  void assets;
  void prices;
  const supplied = portfolio?.supplied ?? portfolio?.positions?.supplied ?? [];
  const borrowed = portfolio?.borrowed ?? portfolio?.positions?.borrowed ?? [];

  const zec = Array.isArray(supplied)
    ? supplied.find((s: any) => String(s?.token_id ?? s?.tokenId ?? "").includes("zec"))
    : undefined;

  const borrowedAssets = (Array.isArray(borrowed) ? borrowed : []).map((b: any) => ({
    symbol: (b?.symbol ?? "USDC") as BorrowAssetSymbol,
    amountAtomic: String(b?.balance ?? b?.amount ?? "0"),
  }));

  const hasDebt = borrowedAssets.some((b) => {
    try {
      return BigInt(b.amountAtomic) > 0n;
    } catch {
      return true; // unparseable amount → treat as debt (fail closed)
    }
  });

  // Health factor, FAIL-CLOSED at the schema boundary:
  //   • missing / unparseable field WITH debt → NaN (assessHealth escalates
  //     CRITICAL/NOTIFY) — never Infinity, which reads as "no debt = healthy".
  //   • missing WITHOUT debt → Infinity (genuinely no borrow leg).
  //   • bounds check 0 < hf < 1e3: an SDK reporting bps (e.g. 10500) or any
  //     absurd magnitude is suspect data → NaN, not a silently-healthy read.
  //     (A percent-unit feed like 105 is inside these bounds — the unit is
  //     additionally pinned against a recorded SDK fixture in the tests.)
  const rawHf = Number(portfolio?.healthFactor ?? portfolio?.health_factor ?? NaN);
  const bounded = Number.isFinite(rawHf) && rawHf > 0 && rawHf < 1e3 ? rawHf : NaN;
  const healthFactor = Number.isFinite(bounded) ? bounded : hasDebt ? NaN : Infinity;

  return {
    mcaId,
    suppliedZecAtomic: String(zec?.balance ?? zec?.amount ?? "0"),
    borrowedAssets,
    healthFactor,
    borrowHeadroomUsd: Number(portfolio?.borrowHeadroomUsd ?? 0),
  };
}
