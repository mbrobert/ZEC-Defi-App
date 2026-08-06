# Flows

## 1 · Simple deposit

```mermaid
sequenceDiagram
    actor U as User (Zcash wallet)
    participant W as Web app
    participant A as Agent
    participant R as Rhea (NEAR)

    U->>W: configure Simple strategy
    W->>A: create strategy
    A->>R: ensureAccount → MCA + ZEC deposit address
    A-->>W: deposit address (status AWAITING_ZEC_DEPOSIT)
    U->>R: send ZEC to deposit address
    A->>R: detect arrival → supplyZec
    A-->>W: status ACTIVE_SIMPLE (earning supply APY)
```

## 2 · Full strategy deposit (continues from step 1)

```mermaid
sequenceDiagram
    participant A as Agent
    participant R as Rhea (NEAR)
    participant I as NEAR Intents
    participant V as PositionVault (Base)
    participant L as MaxFi/SnuggleFi

    A->>R: borrow(asset, amount, deliverTo: vault@Base)
    R->>I: cross-chain delivery intent
    I->>V: asset arrives at vault
    A->>V: openFor(user, adapter, pool, amount, LpParams, rewardPref, zcashAddr)
    V->>L: adapter → createPosition(exact user params)
    A-->>A: status ACTIVE_FULL
```

Simple → Full upgrade is exactly this flow run later against an existing
`ACTIVE_SIMPLE` strategy (`UpgradeExecutor`), with idempotent persisted steps.

## 3 · Reward → native ZEC

```mermaid
sequenceDiagram
    participant A as Agent
    participant O as 1-Click API
    participant RR as RewardRouter (Base)
    participant V as PositionVault
    participant I as NEAR Intents solvers
    actor U as User's Zcash wallet

    A->>A: decideReward(accrued vs gas+bridge × multiple)
    A->>O: POST /v0/quote (USDC→ZEC, recipient = user's zaddr)
    O-->>A: quote { depositAddress, amountOut }
    A->>A: VERIFY recipient == stored zaddr && dest == native ZEC
    A->>RR: routeToZcash(positionId, depositAddress, quoteHash)
    RR->>V: claimTo(router) → rewards
    RR->>I: transfer USDC to depositAddress + emit RewardsRouted
    A->>O: POST /v0/deposit/submit (txHash)
    I->>U: native ZEC delivered
    A->>O: GET /v0/status until SUCCESS
```

Compound preference short-circuits after `decideReward`: `RewardRouter.compound`
claims and re-deposits the matching token in one transaction.

## 4 · Health-factor protection

```mermaid
stateDiagram-v2
    [*] --> HEALTHY
    HEALTHY --> WARNING: HF ≤ 1.5
    WARNING --> HEALTHY: HF recovers
    WARNING --> CRITICAL: HF ≤ 1.2
    CRITICAL --> WARNING: partial repay
    state CRITICAL {
        [*] --> REDUCE_LEVERAGE
        REDUCE_LEVERAGE --> EMERGENCY_UNWIND: HF ≤ 1.05
    }
```

WARNING notifies. CRITICAL withdraws a slice of the LP position, bridges back,
and repays (deleverage). EMERGENCY_UNWIND exits the LP leg entirely and repays
to a safe HF. Only band *transitions* alert — no repeat spam.

## 5 · Withdrawal

Position owner calls `vault.withdraw(positionId, shareBps, recipient)` — never
pausable, never operator-gated. `recipient` may be the user's Base address or a
1-Click deposit address to route straight back to native ZEC. Rhea-side
collateral withdrawal reverses supply via the agent once debt is cleared.
