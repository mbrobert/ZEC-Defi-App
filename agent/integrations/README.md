# Optional integrations

The agent core is intentionally **zero-dependency** (Node ≥ 20 stdlib only):
it monitors, decides, and reads chain state with nothing but `fetch` and a
vendored keccak. Two integrations upgrade it to full write capability:

## 1. viem — transaction signing on Base (`viem-basechain.example.ts`)

The zero-dep `RpcReadOnlyChainService` covers every read but refuses writes
(`compound`, `routeToZcash`) because transaction signing should come from a
maintained library, not hand-rolled crypto.

To enable writes:

```bash
npm i viem -w @zyo/agent
```

then move `viem-basechain.example.ts` into `src/services/`, rename the class
to implement `ChainService`, and construct it in `src/index.ts` when
`OPERATOR_PRIVATE_KEY` is set. The file already compiles against viem ^2.x.

## 2. @rhea-finance/cross-chain-sdk — real Rhea lending

`src/services/rhea.ts` ships a `MockRheaService` (default, `RHEA_MODE=mock`)
and a `RheaSdkService` shell. To wire the real thing:

```bash
npm i @rhea-finance/cross-chain-sdk -w @zyo/agent
```

then implement each `RheaService` method against the SDK:
- `ensureAccount` → MCA creation + intent-based ZEC deposit address
- `getAccountState` → supplied/borrowed balances + health factor
- `borrow` → borrow with cross-chain delivery (destination: Base vault)
- `supplyZec` / `repay` / `withdrawZec`

Keep the `RheaService` interface stable — monitors/executors depend on it,
and the mock stays the test double either way.
