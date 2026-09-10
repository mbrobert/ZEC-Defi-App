// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LoanDust — the one threshold below which loan-token debt is rounding, not a book.
///
/// @notice In UNITS of the loan token (USDC, 6 decimals), never a percentage. The same number lives
///         in `packages/shared/src/dust.ts` (`LOAN_DUST_UNITS`) for the keeper and the web, with the
///         rationale; the agent's ABI seam fails if the two differ. Measured 2026-09-10 on a Base
///         fork at block 51,127,409 (`VERIFIED-BASE-FACTS.md` Addendum 3): Aave reads a same-block
///         borrow one unit over what it lent and the aToken one unit under what was supplied — ray
///         math rounds by at most a unit per operation, Morpho's `toAssetsUp` by at most a unit per
///         market. 100 is two orders above any such error and five below the smallest amount anyone
///         would spend a transaction on.
///
///         It governs what the router DECIDES (which venue holds the position, `RISKS.md` §8), not
///         what the venues do: Aave and Morpho still refuse to release the last of the collateral
///         while a single unit is owed, so a full exit must repay the full `debt()`.
library LoanDust {
    uint256 internal constant UNITS = 100;

    function isDust(uint256 loanTokenAmount) internal pure returns (bool) {
        return loanTokenAmount <= UNITS;
    }
}
