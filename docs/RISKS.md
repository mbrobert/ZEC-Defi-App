# Risks & trust assumptions

Honest accounting of what can go wrong and what we do about it. "Mitigation"
never means "eliminated".

## Financial risks (user-facing)

| Risk | Description | Mitigation |
|------|-------------|------------|
| Liquidation | ZEC price drop pushes HF under 1.0; Rhea liquidates collateral | LTV capped at 50% (< protocol max); live HF + liquidation price shown pre-commit; agent bands at 1.5/1.2/1.05 with notify → deleverage → unwind |
| Impermanent loss | Concentrated LP ranges concentrate IL as well as fees | Plain-language preset descriptions; curated pools biased to stable/blue-chip pairs; zero-swap rebalancing (the engines') avoids crystallizing IL on rebalance |
| Out-of-range decay | Tight ranges spend time earning nothing | rebalanceDelay is user-controlled; dashboard shows range status |
| Bridge latency/failure | Intents transfer stalls or refunds | Every 1-Click quote carries `refundTo` (vault or user MCA); status poller surfaces `REFUNDED`/`FAILED`; state machine never advances on unconfirmed arrival |
| Rate drift | Borrow APR can exceed LP APR | Agent computes net APY; dashboard surfaces it (roadmap: auto-alert on negative carry) |

## Protocol/dependency risks

| Risk | Mitigation |
|------|------------|
| Rhea market risk (bad debt, oracle) | Position sizes bounded by LTV cap; monitor-only integration keeps exposure legible |
| MaxFi/SnuggleFi contract risk | Thin adapters — engine failure never corrupts vault accounting (shares read from the engine); withdrawal path independent of reward path |
| 1-Click API availability | Claims are deferrable — rewards accrue on-chain until routing succeeds; deposit/submit failure tolerated (solvers auto-detect) |
| ABI drift | `IConcentratedPositionManager` marked FINALIZE_ABI; single-file swap; adapter integration tests against a mock manager |

## Trust assumptions (be explicit)

1. **Operator ↔ quote binding.** The chain cannot verify that a 1-Click deposit
   address corresponds to a quote whose recipient is the user's Zcash address.
   A malicious operator could route rewards to a quote paying itself.
   Defense-in-depth: agent-side hard invariants (recipient == stored zaddr,
   dest == native ZEC) before any tx; only reward flows (never principal) touch
   this path; per-token per-tx caps; `RewardsRouted(quoteHash, zcashAddress)`
   events make misrouting provable after the fact. Roadmap: publish signed
   quotes so third parties can audit event↔quote pairs automatically.
2. **Admin keys.** Owner can whitelist adapters/tokens and set caps. Withdrawal
   rights are hard-coded outside admin reach. Deploy with a multisig + timelock.
3. **Agent liveness.** A dead agent misses HF protection. Run redundant
   instances (store is single-writer v1 — see roadmap), and alerting on
   agent-heartbeat.
4. **Zcash address correctness.** Funds sent to a mistyped zaddr are gone.
   UI validates t-addr/UA shape and warns that unified addresses have partial
   intents support; the address echoes on review and on every dashboard card.
5. **Price sources.** Claim economics use a price feed (1-Click token prices in
   v1). Manipulated prices could cause premature/late claims — never loss of
   principal.

## Known v1 limitations

- `openFor` trusts operator sequencing of bridged arrivals (single operator);
  multi-operator accounting needs per-user deposit attribution (roadmap:
  deterministic per-strategy deposit sub-accounts).
- Non-matching reward tokens accumulate in the router pending manual sweep
  (`UnmatchedReward` events) until a whitelisted swap route ships.
- Agent store is a JSON file — single instance only; move to Postgres before
  running redundant agents.
- Unified-address reward delivery depends on intents' partial UA support —
  default recommendation is a transparent address.
