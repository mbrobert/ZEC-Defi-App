use anchor_lang::prelude::*;

#[error_code]
pub enum OilskinError {
    #[msg("Only the account owner may do this")]
    NotOwner,
    #[msg("The wallet is a program-derived address; an account owner must be a signing key")]
    OwnerIsPda,
    #[msg("Health factor after this action is below the entry floor")]
    EntryHfTooLow,
    #[msg("Loan-to-value after this borrow is above what Oilskin offers for this collateral")]
    LtvAboveOffer,
    #[msg("Health factor after this withdraw is below the exit floor and the debt is not dust")]
    ExitHfTooLow,
    #[msg("The obligation was not refreshed in this slot")]
    ObligationStale,
    #[msg("The reserve's price was not fully checked at its last refresh")]
    PriceNotChecked,
    #[msg("Health arithmetic overflowed")]
    HealthOverflow,
    #[msg("Kamino account layout is not the one this program was built against")]
    UnexpectedKaminoLayout,
    #[msg("A Kamino account is not the one this market uses")]
    WrongKaminoAccount,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Grant parameters are invalid")]
    InvalidGrant,
    #[msg("The grant is not live (expired, revoked, or from an older epoch)")]
    GrantNotLive,
    #[msg("This rung is not allowed by the grant")]
    RungNotAllowed,
    #[msg("Unknown rung id")]
    UnknownRung,
    #[msg("The named rung is not crossed: the account is healthier than that")]
    RungNotCrossed,
    #[msg("A more severe rung is crossed than the one named")]
    RungUnderstated,
    #[msg("Repay budget for this period is exhausted")]
    RepayBudgetExceeded,
    #[msg("Sell budget for this period is exhausted or selling is not permitted by the grant")]
    SellBudgetExceeded,
    #[msg("The action did not lift the health factor to the rung's disarm level and no budget was exhausted")]
    ProtectionIneffective,
    #[msg("Sale proceeds are below the Scope-priced floor")]
    SaleBelowFloor,
    #[msg("Nothing to revoke: no grant exists for this keeper")]
    NotRevocable,
    #[msg("A live grant exists; revoke it before releasing the obligation")]
    GrantStillLive,
    #[msg("The account's USDC balance cannot cover the debt")]
    InsufficientUsdcToClose,
    #[msg("Token account is not the account's associated token account for that mint")]
    WrongTokenAccount,
}
