/**
 * Oilskin contract ABIs — re-exported from the GENERATED file, which is
 * produced by scripts/sync-abi.mjs from contracts/abi/oilskin-abi.json (the
 * compiled artifact bundle). Nothing here is hand-written; test/abi.test.ts
 * fails on any drift between the generated file and the artifact.
 *
 * Calling convention (CONTRACT-ABI-DELTA.md): nobody calls the router or a
 * venue from a wallet. Every mutating call goes through the account — and the
 * peripheral rights are now OPT-IN per call. `exec(target, 0, data)` is a
 * PLAIN call and gives the target no rights over the account (use it for a
 * token, a pool, Permit2); `execWithCallback(target, 0, data)` — or a `Call`
 * with `callback: true` inside `execBatch` / `createAccountAndExec` — is what
 * the router, the venues and the swap adapter need. The Permit2 spender is the
 * (predicted) account address.
 */
export {
  ABI_BUNDLE_SHA256,
  AAVE_V3VENUE_ABI as AAVE_VENUE_ABI,
  AERODROME_CLPOOL_ABI,
  AERODROME_SWAP_ADAPTER_ABI as SWAP_ADAPTER_ABI,
  COLLATERAL_REGISTRY_ABI,
  COLLATERAL_VENUE_ABI,
  OILSKIN_ACCOUNT_ABI as ACCOUNT_ABI,
  OILSKIN_ACCOUNT_FACTORY_ABI as FACTORY_ABI,
  PERMIT2_ABI,
  SELECTORS,
  SNUGGLE_LP_VENUE_ABI as LP_VENUE_ABI,
  SNUGGLE_VAULT_ABI,
  STRATEGY_ROUTER_ABI as ROUTER_ABI,
} from "./oilskin.generated";

/** "verified" = generated from the compiled artifact and checked by test/abi.test.ts. */
export const ABI_STATUS: "provisional" | "verified" = "verified";
