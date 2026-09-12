//! Oilskin — Solana module.
//!
//! The Solana twin of `OilskinAccount` + its keeper grant: an account PDA (program-derived address) the
//! user's wallet owns, which in turn owns a Kamino obligation on the ZCASH market, with a delegated keeper
//! instruction limited to the health ladder's rungs and revocable by the owner.
//!
//! STATUS (2026-09-12): scaffold only. By the founder's instruction (handoff Step 7c) **no instruction
//! handlers are written until `docs/SOLANA-ARCHITECTURE.md` has been committed and read.** The program id is
//! Anchor's placeholder; `anchor keys sync` replaces it at the first build (the keypair it generates lives in
//! `target/deploy/`, which is gitignored and must never be committed or read into a Claude session).
//!
//! The only code here is the shared ladder, generated from `packages/shared` by
//! `solana/scripts/gen-ladder.mjs` and pinned by `solana/test/ladder-seam.test.mjs`.

use anchor_lang::prelude::*;

pub mod generated;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod oilskin {
    use super::*;
    // Intentionally empty — see the module doc. The instruction set is specified in
    // docs/SOLANA-ARCHITECTURE.md §3 and lands only after that document is approved.
}
