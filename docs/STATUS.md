# Status — generated, never hand-written

<!-- Written by scripts/status.mjs (`npm run status`). Do not edit by hand: every number
     below came from running the command in its own row, on the tree named here. README.md
     carries the prose and no numbers; this file carries the numbers and no prose. -->

_Generated 2026-09-16T22:43:17Z by `npm run status` on darwin-arm64, Node 22.23.2._

**Tree:** the working tree at `76a52cb` on `main`, with **11 file(s) modified on top of it** — including this one, when it is regenerated just before a commit. Each suite ran against that tree, not against a published commit.

Abbreviations: ABI = application binary interface; e2e = end-to-end; HF = health factor;
LP = liquidity provision; RPC = remote procedure call; CCTP = Circle's Cross-Chain Transfer Protocol.

## Suites

| Area | Command | Result |
|---|---|---|
| Contracts (Foundry) | `cd contracts && forge test` | **433 passed / 0 failed / 13 skipped** (446 total), 39 suites |
| Contracts, fork | `FORK_URL=<Base archive RPC> forge test --match-path test/fork/BaseFork.t.sol` | not run — add `--all` |
| Root ABI seam | `node scripts/verify-abi.mjs` | **444** selectors / topics / errors across 19 contracts |
| Shared | `npm test -w @zyo/shared` | **132** |
| Solana, seams | `npm test -w @zyo/solana` | **14** |
| Solana, program unit | `cd solana && cargo test --manifest-path programs/oilskin/Cargo.toml` | not run — add `--all` |
| Solana, localnet | `bash solana/scripts/localnet.sh (terminal 1) · cd solana && anchor test --skip-build --skip-local-validator (terminal 2)` | not run — add `--all` |
| Keeper | `npm test -w @zyo/agent` | **318**, plus its ABI seam **123 / 123** and the IDL seam **77 / 77** |
| Yield | `npm test -w @zyo/yield` | **181** |
| Web, unit | `npm test -w @zyo/web` | **205** |
| Web, e2e | `cd web && npx playwright test` | not run — add `--all` |
| Web, e2e against Base Sepolia | `cd web && npx playwright test -c playwright.sepolia.config.ts` | not run — add `--all` |
| Prototypes | `node prototype/test/run-all.mjs` | verify-simple **130** · verify-advanced **116** · verify-toggle **62** · fuzz **6** |

Every suite that ran came back green.

What each suite *proves* is `docs/TESTING.md`; what changed and when is `docs/CHANGELOG.md`.
A row that says "not run" is a precondition this invocation did not have, not a failure.

## What is deployed

**Nothing, on any chain.** `docs/DEPLOYMENTS.md` holds no address on any row, which is the
one place a deployed address may come from. No transaction has been signed or broadcast from
this repository; the keeper and the web app read the same file and run in demo / observe-only
mode while it is empty.

## The forecast today

Read out of `services/yield/samples/demo-forecast.json` (the forecast evaluator's own output on
the recorded inputs, `npm run demo-forecast -w @zyo/yield`), sampled **2026-09-13T04:05:41+00:00** at block
**51,241,497**.

- USDC variable borrow rate: **4.5143 %**; entry HF **1.25** at the registry floor **1.25**.
- **0 of the 27 priced cells** beat the borrow on **both** models — 81 pool × setting cells in all, 54 of them unpriced (no calibrated volatility or no emissions to price).
- Best priced cell: **aero-cbbtc-usdc at the "sheltered" width** — LP net **−3.75 %/yr** (closed form), **−3.68 %/yr** (Monte-Carlo calibrated), the user's net **−5.15 %/yr** at that entry HF; it needs **1.72×** today's net emissions to break even.

The forecast is a **forecast, not a gate** (`docs/BUILD-PLAN-2026-09-12.md` D4/D5): every curated
pool is depositable in both modes once the user has seen these numbers and acknowledged them.
Refusals are safety only. Re-read the chain before believing any of it — `docs/TESTING.md`.

## Audit history

No external audit has been done. These are internal adversarial passes, each on the tree it names,
with the severities the document itself records; the inquiries to external firms went out 2026-09-13
(`docs/AUDIT-INQUIRY-2026-09-13.md`, shortlist in `docs/AUDIT-SHORTLIST-2026-09.md`).

| Record | What it covered | Findings |
|---|---|---|
| [`AUDIT-2026-09-06.md`](AUDIT-2026-09-06.md) | Internal adversarial audit — wave 1, and the fix round it produced (2026-09-06) | 1 Critical · 10 High · 23 Medium · 24 Low · 8 Info |
| [`AUDIT-2026-09-07.md`](AUDIT-2026-09-07.md) | Internal adversarial audit — wave 2, Steps 1–5 (2026-09-07) | 3 High · 7 Medium · 4 Low · 5 Info |
| [`AUDIT-2026-09-11.md`](AUDIT-2026-09-11.md) | Internal adversarial audit — wave 3 (2026-09-11) | 3 Medium · 7 Low · 10 Info |
| [`AUDIT-2026-09-12.md`](AUDIT-2026-09-12.md) | Finding from the nightly invariant configuration — NI-HIGH-1 (2026-09-12) | 1 High |
| [`AUDIT-2026-09-13.md`](AUDIT-2026-09-13.md) | Internal audit — the Solana module and the cross-chain code, 2026-09-13 | 5 Medium · 1 Low |
| [`AUDIT-FINDINGS-2026-09-03.md`](AUDIT-FINDINGS-2026-09-03.md) | Project Oilskin — pre-audit findings, waves 1 and 2 (2026-09-03) | stated per finding in the document |

Fix commits, the failing scenario and the regression test path are inside each record;
the regression tests themselves are `contracts/test/audit-regressions/`.

## Every document in docs/

All 57 documents beside this one, from an `ls` of `docs/` at generation time, each with its own first heading, plus the subdirectory `docs/research/`.

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — Architecture — Base module v1 (the Solana module is designed in `SOLANA-ARCHITECTURE.md`)
- [`AUDIT-2026-09-06.md`](AUDIT-2026-09-06.md) — Internal adversarial audit — wave 1, and the fix round it produced (2026-09-06)
- [`AUDIT-2026-09-07.md`](AUDIT-2026-09-07.md) — Internal adversarial audit — wave 2, Steps 1–5 (2026-09-07)
- [`AUDIT-2026-09-11.md`](AUDIT-2026-09-11.md) — Internal adversarial audit — wave 3 (2026-09-11)
- [`AUDIT-2026-09-12.md`](AUDIT-2026-09-12.md) — Finding from the nightly invariant configuration — NI-HIGH-1 (2026-09-12)
- [`AUDIT-2026-09-13.md`](AUDIT-2026-09-13.md) — Internal audit — the Solana module and the cross-chain code, 2026-09-13
- [`AUDIT-FINDINGS-2026-09-03.md`](AUDIT-FINDINGS-2026-09-03.md) — Project Oilskin — pre-audit findings, waves 1 and 2 (2026-09-03)
- [`AUDIT-INQUIRY-2026-09-13.md`](AUDIT-INQUIRY-2026-09-13.md) — Audit inquiry — ready to send (draft, 2026-09-13)
- [`AUDIT-LEDGER-2026-08.md`](AUDIT-LEDGER-2026-08.md) — Internal security review — v0.5 (2026-08-06)
- [`AUDIT-SCOPE.md`](AUDIT-SCOPE.md) — Audit scope — Base module v1 (tree of 2026-09-06)
- [`AUDIT-SHORTLIST-2026-09.md`](AUDIT-SHORTLIST-2026-09.md) — Audit shortlists — EVM (Base module) and Solana (Solana module)
- [`AUDIT.md`](AUDIT.md) — Audit status — Base module v1 (2026-09-06)
- [`BACKLOG.md`](BACKLOG.md) — Backlog — everything deliberately deferred, in one place
- [`BASE-PIVOT-2026-09.md`](BASE-PIVOT-2026-09.md) — The Base-first pivot — thinking, trade-offs, and the twenty things to fix
- [`BETA-SCOPE-2026-09-13.md`](BETA-SCOPE-2026-09-13.md) — Beta scope — the "in" and "not in beta" lists (draft, 2026-09-13)
- [`BUILD-PLAN-2026-09-12.md`](BUILD-PLAN-2026-09-12.md) — Build plan — the defined path (decided 2026-09-12)
- [`BUILD-SPEC-2026-09.md`](BUILD-SPEC-2026-09.md) — Oilskin v1 — build spec (2026-09, superseded; see the banner above)
- [`CBZEC-2026-09.md`](CBZEC-2026-09.md) — cbZEC — Coinbase Wrapped ZEC on Base. What it is, and what it means for Oilskin.
- [`CBZEC-PATH-2026-09.md`](CBZEC-PATH-2026-09.md) — The cbZEC path — three options, with the numbers read on 2026-09-10
- [`CHANGELOG.md`](CHANGELOG.md) — Changelog
- [`CONTRACT-ABI.md`](CONTRACT-ABI.md) — Oilskin Base module v1 — contract ABI (the seam the keeper and the web encode from)
- [`CROSSCHAIN-LOOP-2026-09-12.md`](CROSSCHAIN-LOOP-2026-09-12.md) — The cross-chain loop — ZEC on Solana, USDC to Base, LP on Base (design note, 2026-09-12)
- [`CROSSCHAIN-RUNBOOK-2026-09-13.md`](CROSSCHAIN-RUNBOOK-2026-09-13.md) — The cross-chain rung, step by step — what runs, what can fail, and what a person must do
- [`DEPLOY-SEPOLIA.md`](DEPLOY-SEPOLIA.md) — Deploying Oilskin to Base Sepolia (chain id 84532)
- [`DEPLOYMENTS.md`](DEPLOYMENTS.md) — Deployments — every address Oilskin has put on a chain, with its date and block
- [`DEPOSIT-FLOW.md`](DEPOSIT-FLOW.md) — How a deposit flows — Oilskin v1 (Base module)
- [`DIRECTION-2026-09-11.md`](DIRECTION-2026-09-11.md) — Direction record — chain-agnostic, ZEC-holder-centric (2026-09-11)
- [`FEEDBACK-ANSWERS-2.md`](FEEDBACK-ANSWERS-2.md) — Feedback round 2 — custody, wallet connections, venues, names (2026-08-13)
- [`FEEDBACK-ANSWERS.md`](FEEDBACK-ANSWERS.md) — Feedback round 1 — answers & decisions (2026-08-13)
- [`FLOWS.md`](FLOWS.md) — Flows — the exact calls the user signs
- [`INTEGRATIONS.md`](INTEGRATIONS.md) — Integration facts (verified 2026-08-05)
- [`MODEL-NUMBERS-2026-09-05.md`](MODEL-NUMBERS-2026-09-05.md) — MODEL-NUMBERS — Base-first yield gate, generated 2026-09-06T04:16:02+00:00
- [`MODEL-NUMBERS-2026-09-12.md`](MODEL-NUMBERS-2026-09-12.md) — MODEL-NUMBERS — Base-first yield gate, generated 2026-09-13T02:43:16+00:00
- [`MODEL-NUMBERS-2026-09-13.md`](MODEL-NUMBERS-2026-09-13.md) — MODEL-NUMBERS — the Base module's yield model, generated 2026-09-13T04:35:28+00:00
- [`PERPS-FEASIBILITY-2026-09-14.md`](PERPS-FEASIBILITY-2026-09-14.md) — Perps and the cross-chain loop in beta — feasibility, cost, and the trade
- [`POOLS.md`](POOLS.md) — Pool research — blue-chip Aerodrome pools the Snuggle engine supports
- [`PRE-AUDIT-2026-09-02.md`](PRE-AUDIT-2026-09-02.md) — Pre-audit sweep — 2026-09-02
- [`PRIVACY.md`](PRIVACY.md) — Privacy — what is known about you, by whom
- [`RFP-EVM-2026-09-13.md`](RFP-EVM-2026-09-13.md) — Request for proposal — security audit, Oilskin **Base module** (EVM)
- [`RFP-SOLANA-2026-09-13.md`](RFP-SOLANA-2026-09-13.md) — Request for proposal — security audit, Oilskin **Solana module** (Anchor / Rust)
- [`RHEA-SDK.md`](RHEA-SDK.md) — @rhea-finance/cross-chain-sdk — extracted API (v0.1.20, npm, 2026-08-05)
- [`RISKS.md`](RISKS.md) — Risks — what can go wrong, what mitigates it, what does not
- [`ROADMAP.md`](ROADMAP.md) — Roadmap — beta into audit before 2026-12-31
- [`RUN-DEMO.md`](RUN-DEMO.md) — Running the live demo (one click)
- [`SECURITY-REVIEW-2026-08.md`](SECURITY-REVIEW-2026-08.md) — Oilskin — internal security review (2026-08-16)
- [`SEPOLIA-REHEARSAL.md`](SEPOLIA-REHEARSAL.md) — The Base Sepolia rehearsal — what it proves, what it cannot, and the checklist
- [`SOLANA-ARCHITECTURE.md`](SOLANA-ARCHITECTURE.md) — Solana module — architecture (design record, 2026-09-12; program and keeper built and proven on localnet the same day)
- [`SOLANA-DEPLOY.md`](SOLANA-DEPLOY.md) — Solana deploy and the Squads hand-over — runbook (2026-09-13; nothing deployed yet)
- [`TESTING.md`](TESTING.md) — Testing — every suite, how to run it, what it proves
- [`UX-TEARDOWN.md`](UX-TEARDOWN.md) — UX teardown — Aerodrome · Curve · Convex · Morpho · Pendle → ZYO decisions
- [`V1-SIMPLE.md`](V1-SIMPLE.md) — Oilskin v1 — the simple build (pivot decision record, 2026-08-13)
- [`VERIFIED-BASE-FACTS.md`](VERIFIED-BASE-FACTS.md) — Verified Base mainnet facts for the Base module (first read 2026-09-05 ~01:00 UTC; top ledger re-read 2026-09-13 at block 51,241,497, 04:05:41 UTC; chain id 8453)
- [`VERIFIED-PERPS-FACTS-2026-09-14.md`](VERIFIED-PERPS-FACTS-2026-09-14.md) — Verified perps facts — read 2026-09-13/14, nothing typed from memory
- [`VERIFIED-SOLANA-FACTS.md`](VERIFIED-SOLANA-FACTS.md) — Verified Solana mainnet facts for the Solana module (read live 2026-09-12 00:36–00:57 UTC, slots 446,294,693 → 446,298,641)
- [`YIELD-REALITY-2026-08-31.md`](YIELD-REALITY-2026-08-31.md) — Yield reality check — measured 2026-08-31
- [`YIELD-SERVICE.md`](YIELD-SERVICE.md) — The yield service — live Base rates, gauge emissions, the gate, and empirical bands
- [`ZEC-FORMS-AND-DOORS-2026-09-15.md`](ZEC-FORMS-AND-DOORS-2026-09-15.md) — ZEC forms, and the two doors — plan of record for the Zcash direction

## Regenerating this file

```bash
npm run status            # the suites that need nothing but this checkout
npm run status -- --all   # plus fork, Solana localnet, cargo and the Playwright suites
npm run status -- --check # regenerate and exit 1 if this file was out of date
```
