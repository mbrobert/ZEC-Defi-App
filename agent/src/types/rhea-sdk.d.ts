/**
 * Ambient types for @rhea-finance/cross-chain-sdk (v0.1.20), hand-extracted
 * from the published package's index.d.ts + README (see docs/RHEA-SDK.md).
 * Deliberately loose (`any` payloads) — the package's own types take over the
 * moment it is actually installed; these exist so the zero-dependency build
 * typechecks the dynamic-import call sites.
 */
declare module "@rhea-finance/cross-chain-sdk" {
  export type IChain = "evm" | "btc" | "solana" | "near" | string;

  export const BURROW_CONTRACT_ID: string;

  export function format_wallet(args: { chain: IChain; identityKey: string }): unknown;
  export function serializationObj(wallets: unknown[]): string;
  export function prepare_sign_message_evm(message: string): string;
  export function process_signature_evm(signature: string): unknown;

  export function getMcaByWallet(args: { chain: IChain; identityKey: string }): Promise<any>;
  export function getListWalletsByMca(mca: string): Promise<any>;
  export function getZcashCreateMcaDepositAddress(am_id: string): Promise<string>;
  export function getCreateMcaCustomRecipientMsg(args: {
    useAsCollateral: boolean;
    wallets: unknown[];
    signedMessages: unknown[];
  }): unknown;
  export function getCreateMcaFeeData(args: {
    asset: unknown;
    bufferMultiple?: number;
  }): Promise<any>;

  export function getSupplyCustomRecipientMsg(args: {
    useAsCollateral: boolean;
    w: unknown;
  }): unknown;
  export function intentsQuotation(args: Record<string, unknown>): Promise<any>;

  export function batchViews(...args: unknown[]): Promise<any>;
  export function getAccountAllPositions(...args: unknown[]): Promise<any>;
  export function getAssets(...args: unknown[]): Promise<any>;
  export function getAssetsDetail(...args: unknown[]): Promise<any>;
  export function getPrices(...args: unknown[]): Promise<any>;
  export function getConfig(...args: unknown[]): Promise<any>;
  export function getBorrowMaxAmount(...args: unknown[]): any;
  export function getWithdrawMaxAmount(...args: unknown[]): any;

  export function computeRelayerGas(args: Record<string, unknown>): any;
  export function prepareBusinessDataOnBorrow(args: {
    mca: string;
    recipient: string;
    tokenId: string;
    originAsset: string;
    destinationAsset: string;
    amountBurrow: string;
    amountToken: string;
    config: unknown;
    simpleWithdrawData: unknown;
  }): Promise<{ businessMap: unknown; quoteResult: unknown }>;
  export function prepareBusinessDataOnRepayFromSupplied(
    args: Record<string, unknown>
  ): Promise<any>;
  export function prepareBusinessDataOnWithdraw(args: Record<string, unknown>): Promise<any>;
  export function prepareBusinessDataOnClaim(args: Record<string, unknown>): Promise<any>;
  export function submitSignedTransactionToRelayer(...args: unknown[]): Promise<any>;

  export function setSdkEnv(env: string): void;
  export function setCustomNodeUrl(url: string): void;
}
