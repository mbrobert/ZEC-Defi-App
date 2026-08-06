# @rhea-finance/cross-chain-sdk — extracted API (v0.1.20, npm, 2026-08-05)

Verified by unpacking the published package. "Cross-chain lending SDK …
EVM chains, Solana, Bitcoin, and NEAR." Lending contract: Burrow
(`BURROW_CONTRACT_ID` exported). Docs repo: github.com/rhea-finance/rhea-sdk-docs.

## The execution pattern (all mutations)

```
format_wallet({chain, identityKey})
  → serializationObj([...])                    // message to sign
  → prepare_sign_message_{evm|btc|solana}(msg)
  → <wallet signs>                             // outside the SDK
  → process_signature_{evm|btc|solana}(sig)
  → prepareBusinessDataOn{Borrow|Claim|Withdraw|RepayFromSupplied|WithdrawRewards}(...)
  → submitSignedTransactionToRelayer(...)      // relayer pays NEAR gas
```

Deposits (MCA create / supply) instead flow through **intents quotation**:
`getCreateMcaCustomRecipientMsg` / `getSupplyCustomRecipientMsg` →
`intentsQuotation({recipient: "rhea00000x.multica.near" | mca, customRecipientMsg, …})`
→ user transfers to `quoteResult.quoteSuccessResult.quote.depositAddress`.

## Calls that map to our RheaService

| Ours | SDK |
|------|-----|
| ensureAccount (ZEC user) | `getMcaByWallet({chain, identityKey})`; create: `getCreateMcaCustomRecipientMsg` + `getCreateMcaFeeData({asset, bufferMultiple:1.05})` + `intentsQuotation`; **Zcash-native path: `getZcashCreateMcaDepositAddress(am_id)`** (README also has "Create MCA via Zcash (Old way)" + `getZcashResponseDataByAddress`) |
| supplyZec | `getSupplyCustomRecipientMsg({useAsCollateral:true, w})` → `intentsQuotation` → send ZEC to depositAddress |
| getAccountState | `batchViews` / `getAccountAllPositions(View)`, `getAssets(Detail)`, `getPrices`, `getConfig`; health: `recomputeHealthFactor{Supply,Borrow,Repay,Withdraw,Adjust,RepayFromDeposits}`, `getAdjustedSum`, `getBorrowMaxAmount`, `getWithdrawMaxAmount` |
| borrow (deliver to Base vault) | `computeRelayerGas({nearStorageAmount, mca, relayerGasFees, assets, portfolio})` → `prepareBusinessDataOnBorrow({mca, recipient: <Base vault 0x…>, tokenId, originAsset, destinationAsset, amountBurrow, amountToken, config, simpleWithdrawData})` → sign → relayer |
| repay | "Cross-chain Repay" + `prepareBusinessDataOnRepayFromSupplied` |
| withdrawZec | `prepareBusinessDataOnWithdraw` / `get_simple_withdraw_tx`; rewards: `prepareBusinessDataOnWithdrawRewards` |
| claim rewards | `prepareBusinessDataOnClaim` |

Other useful exports: `setSdkEnv`/`getSdkEnv`, `setCustomNodeUrl(s)`,
`view_on_near`, `query_account_register_token_tx`, `getListWalletsByMca`,
`getCreateMcaFee(Paged)`, `getAuthenticationHeaders`, farms
(`getAllFarms`, `transformFarms`), token math (`expandToken`, `shrinkToken`).

## Integration notes

1. Mutations require a signing wallet (EVM/BTC/Solana identity bound to the
   MCA). The agent's operator key can be that identity — sign with
   `prepare_sign_message_evm` → secp256k1 sign → `process_signature_evm`.
2. `recipient` on borrow is the cross-chain delivery target — set it to the
   PositionVault address for the Full-Strategy leg. This confirms our
   architecture end-to-end.
3. Supply/MCA-create are deposit-address flows (same intents primitive the
   reward path uses) — the UI shows the address, user pays from any wallet.
4. Package: dist/index.js ~820KB + index.d.ts ~48KB, plain npm install on any
   networked machine. Agent keeps it optional: `rheaSdk.ts` dynamic-imports it
   and the ambient types in `types/rhea-sdk.d.ts` keep the build zero-dep.
