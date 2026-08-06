# ZEC Yield Orchestrator — setup & status

Earn yield on **native ZEC**: lend on Rhea Finance (NEAR), run managed
concentrated-liquidity strategies on Base via the MaxFi/SnuggleFi engine, and
take rewards back as native ZEC through NEAR Intents.

## Status (v0.5)

- **Contracts** — Foundry. PositionVault, RewardRouter, SnuggleAdapter (thin
  translator to the live engine), SimpleMultisig (test-only). Verified against
  the **real deployed engine** on a Base mainnet fork.
- **Tests** — 57 local (unit + 540-scenario matrix + 8 stateful invariants over
  ~82k random transitions + slippage/exposure guards) and 9 fork tests against
  the live Base engine. Agent: 62 tests incl. hostile-RPC, hostile-1Click,
  MEV/malicious-quote, extreme-price grids.
- **Agent** — zero-dependency TypeScript daemon (monitors, decision engines,
  1-Click client, executors).
- **Web** — Next.js app + self-contained `prototype/index.html`.
- **Docs** — `docs/ARCHITECTURE.md`, `FLOWS.md`, `RISKS.md`, `AUDIT.md`,
  `INTEGRATIONS.md`, `RHEA-SDK.md`.

## Quickstart

```bash
# contracts (needs Foundry — https://getfoundry.sh)
cd contracts && forge test                 # local suite
FORK_URL=<base-rpc> forge test --match-contract EngineForkTest   # live-engine

# agent (Node >= 20, zero deps)
cd agent && npm test
RHEA_MODE=mock npm run dev

# web
npm install && npm run dev -w @zyo/web

# instant demo, no install
open prototype/index.html
```

## Security posture (see docs/AUDIT.md)

Principal never routes through the reward path; the operator can manage yield
but never redirect principal; user withdrawal is exempt from `pause()`;
per-token routing caps + **per-pool exposure caps** bound concentration;
**withdrawal slippage floor** (`minOut`) protects against MEV sandwiching and
deep price impact. A third-party audit is required before mainnet TVL.

## Pushing the full source (history + all files)

This landing page and the audit report were pushed via the Composio GitHub
connector. To publish the **complete** repository from your machine:

```bash
cd "path/to/zec-yield-orchestrator"
git remote add origin https://github.com/mbrobert/ZEC-Defi-App.git
git push -u origin master
```

`.env` is git-ignored; secrets never leave your disk.
