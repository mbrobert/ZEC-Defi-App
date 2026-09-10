/**
 * ONE dust threshold for "fully repaid" and "holds nothing" — in UNITS OF THE LOAN TOKEN (USDC, 6
 * decimals), never a percentage. Slice C, 2026-09-10 (`docs/RISKS.md` §8 "Rounding dust").
 *
 * Why it exists. Measured on a Base mainnet fork at block 51,127,409 (`VERIFIED-BASE-FACTS.md`
 * Addendum 3): a supply of exactly 1.00000000 cbBTC read back as 0.99999999 (the aToken is a scaled
 * balance, `rayDiv` then `rayMul` by the liquidity index), and a borrow of exactly 10,000 USDC read
 * back as 10,000.000001 in the same block. Aave's ray math rounds by at most one unit per operation;
 * Morpho's `toAssetsUp` by at most one unit per market. An account that holds exactly what it
 * borrowed therefore cannot clear its debt to the unit, and every exact-equality reading of "no debt"
 * — the router's exit routing, the keeper's `confirm` and its NO_DEBT verdict, the dashboard's "No
 * debt" tile — would misread a residual that is rounding, not a loan.
 *
 * Why 100. Two orders of magnitude above the largest rounding error measured or derivable (a unit
 * per operation, a handful of operations), and five below the smallest amount anyone would spend a
 * transaction on (0.0001 USDC). A number in units, not a percentage, because rounding is additive
 * per operation and does not scale with the position.
 *
 * What it does NOT do. It does not make the debt go away: Aave and Morpho still refuse to hand back
 * the last of the collateral while any debt — one unit included — is outstanding (measured, Addendum
 * 6). A close that wants every satoshi back must repay the full `debt()` the venue reports; the
 * threshold only governs what the app SAYS and which book the router and keeper ACT on.
 *
 * `contracts/src/libraries/LoanDust.sol` carries the same number for the contracts; the agent's ABI
 * seam (`agent/scripts/verify-abi.mjs`) fails if the two ever differ.
 */
export const LOAN_DUST_UNITS = 100n;

/** True when `units` of the loan token is rounding, not a book (0 included; negative never). */
export function isLoanDust(units: bigint): boolean {
  return units >= 0n && units <= LOAN_DUST_UNITS;
}

/** The threshold in human units for a loan token with `decimals` (USDC: 0.0001). */
export function loanDustHuman(decimals: number): number {
  return Number(LOAN_DUST_UNITS) / 10 ** decimals;
}

/** `isLoanDust` for an amount already converted to human units (a rendered read). */
export function isLoanDustHuman(amount: number, decimals: number): boolean {
  return Number.isFinite(amount) && amount >= 0 && amount <= loanDustHuman(decimals);
}
