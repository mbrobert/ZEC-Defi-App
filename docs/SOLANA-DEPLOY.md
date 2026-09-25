# Solana deploy and the Squads hand-over — runbook (2026-09-13; nothing deployed yet)

The founder runs every signing step here, in his terminal, with his keys (`CLAUDE.md` rule 1). Claude Code's
part is the read-only checks and this page. Abbreviations: PDA = program-derived address; IDL = interface
definition language (the program's public interface, `solana/idl/oilskin.json`); RPC = remote procedure call;
CU = compute units.

## 0. Why the upgrade authority matters more here than on Base

A Kamino obligation owned by the Oilskin Account PDA cannot be handed to the user's wallet (klend refuses it —
`SOLANA-ARCHITECTURE.md` §3, §12 (3), `BUILD-PLAN-2026-09-12.md` "The S3 finding"). Every exit goes through the
program. So whoever holds the program's **upgrade authority** is in the trust path for the user's *exit*, not
only for the keeper's protection: a frozen or maliciously upgraded program freezes every position with it.
Decision 2 (2026-09-12): the authority goes to a **Squads Protocol v4 multisig** at deploy; until that hand-over
a single deployer key holds it, and the copy says so (`RISKS.md` §22).

Squads Protocol v4's own program (`SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu`) is executable and
**immutable** — its ProgramData carries no upgrade authority (read 2026-09-13 02:42 UTC, slot 446,591,426;
`VERIFIED-SOLANA-FACTS.md` Addendum 2). The multisig program cannot be changed under the vault that will hold
our authority.

## 1. Before anything is deployed

1. **The multisig exists first.** Create it in the Squads app (v4), with the members and threshold the founder
   decides (his call, not this page's). Write down the **vault** address (the PDA that signs as the multisig)
   and the multisig config account address — they are different accounts; the vault is the one that becomes the
   authority. Fund the vault with a little SOL so it exists on chain: the check below refuses an absent account,
   so that a typo cannot become the authority.
2. **The build is the committed one.** `cd solana && anchor build && node scripts/sync-idl.mjs --check` must
   print "matches the build" for both IDLs; CI's `solana-program` job proves the same on every push.
3. **The program id.** `anchor keys sync` binds `declare_id!` and `Anchor.toml` to `target/deploy/oilskin-keypair.json`
   (gitignored, never read into a session). The localnet id `Gw2UE3MixYgA8c7nLZC9UF2z3z5dWfzrFW7ESmi5Scog` is
   that keypair's; the mainnet id is whatever keypair the founder deploys with — record it, do not assume it.
4. **The generated constants are current.** `node solana/scripts/gen-ladder.mjs --check` and
   `node solana/scripts/gen-addresses.mjs --check` (the ladder and every Kamino/Scope/token address the program
   hard-codes come from `packages/shared`, and the addresses were read live — `VERIFIED-SOLANA-FACTS.md`).
5. **The audit.** Decision 7: one audit for both modules, on a fixed commit hash, before any mainnet deploy
   (`AUDIT-SHORTLIST-2026-09.md`). This page does not change that order.

## 2. Deploy — the founder, his key

```bash
cd solana
anchor build
anchor deploy --provider.cluster mainnet --provider.wallet ~/.config/solana/<deployer>.json
# or, equivalently:
# solana program deploy target/deploy/oilskin.so --program-id target/deploy/oilskin-keypair.json --url <rpc> --keypair ~/.config/solana/<deployer>.json
```

The deployer key is the upgrade authority the moment the deploy lands. `mock_scope` is **never** deployed to
mainnet (it exists only so the localnet can stamp Scope prices — `Anchor.toml` does not list it under
`[programs.mainnet]`; keep it that way).

## 2b. The address lookup table both cross-chain transactions need (2026-09-13)

`deposit_for_burn` and `receive_message` each carry more accounts than a legacy transaction holds — the
delivery measured **1,264 bytes against the 1,232 limit** on localnet — so both ride v0 transactions with an
address lookup table. One table, created once, covering Kamino's context and Circle's accounts.

```bash
# read-only: the exact 31 addresses and the commands below, filled in
node solana/scripts/lookup-table.mjs --rpc <url>
# the authority may be the deployer key; the table is public data and holds no funds
solana address-lookup-table create --authority <KEY>
solana address-lookup-table extend <TABLE> --addresses <twelve per call, three calls — the script prints them>
# then, a slot or two later
node solana/scripts/lookup-table.mjs --verify <TABLE> --rpc <url>     # exit 0 = complete, 1 = short (says which), 2 = absent
```

The addresses are every static account of the burn and the delivery — the ones `docs/VERIFIED-SOLANA-FACTS.md`
Addenda 3 and 4 record (the two CCTP programs, the token messenger, minter, local token, the domain-6 remote
messenger, the transmitter, the token pair, the custody account, Circle's fee token account, both event
authorities) plus Kamino's market context and its `["lma", market]` authority — listed by the script from
`@zyo/shared`, never typed here (2026-09-25). Per-user and per-message accounts ride as static keys and are not
in the table; the script's header says which. Record the table in
`DEPLOYMENTS.md` and set it for the keeper as `CCTP_LOOKUP_TABLE`; **without it the keeper refuses a delivery
by name** rather than sending a transaction that cannot land. A table extension takes a slot or two to become
usable — extend, then wait, then use.

## 3. Verify what landed (read-only; anyone can run it)

```bash
node solana/scripts/authority.mjs --program <program id> --rpc <rpc>
```

It prints the ProgramData account, the last deploy slot and the current upgrade authority (the deployer at this
point), decoded from the BPF upgradeable loader's own account layouts — no SDK, no network beyond two
`getAccountInfo` reads. Then confirm the IDL the site and keeper carry is the deployed program's:
`anchor idl fetch <program id> --provider.cluster mainnet` (if the IDL account was initialised with
`anchor idl init`) or compare `solana program dump` output's hash with the built `.so`.

## 4. The hand-over

```bash
node solana/scripts/authority.mjs --program <program id> --expect <squads vault> --rpc <rpc>
```

- Exit **2 (PENDING)**: the vault exists on this cluster and is a system-owned PDA (or, with a warning, a
  Squads-owned account — check you gave the vault, not the multisig config); the script prints the exact
  command, which only the founder runs:

  ```bash
  solana program set-upgrade-authority <program id> --new-upgrade-authority <squads vault> --skip-new-upgrade-authority-signer-check --url <rpc>
  ```

  `--skip-new-upgrade-authority-signer-check` is required because a PDA cannot co-sign; that is exactly why the
  script refuses an absent account first.
- Exit **0 (DONE)**: the authority already is the vault. Run it once more after the transaction to see DONE.
- Exit **1**: a refusal by name (program not found, not upgradeable, immutable, the vault absent or owned by
  something else). Nothing to run.

Record in `DEPLOYMENTS.md` (Solana table): program id, ProgramData, deploy slot, the hand-over signature, the
vault, the multisig config, the threshold, the number of members. Then the copy may say "upgrade authority: a
Squads multisig (threshold m of n)" — and must still say that this multisig can upgrade the program.

## 4b. After the hand-over: point the services at the deployment

- Yield service: `SOLANA_RPC_URL=<rpc>` (it samples Kamino's market and serves `/v1/solana/borrow`).
- Keeper: `OILSKIN_SOLANA_PROGRAM_ID=<program id>`, `SOLANA_RPC_URL`, observe-only until a keeper key exists
  (`solana/SETUP.md`); the keeper's public key goes to the web as `NEXT_PUBLIC_OILSKIN_SOLANA_KEEPER`.
- Web: `NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta`, `NEXT_PUBLIC_OILSKIN_SOLANA_PROGRAM=<program id>`,
  `NEXT_PUBLIC_SOLANA_RPC_URL=<rpc>`; the web's encoders are pinned to `solana/idl/oilskin.json` — after any IDL
  change run `node solana/scripts/sync-idl.mjs` then `node web/scripts/sync-solana-idl.mjs`, and both seams
  (`npm test -w @zyo/agent`, `npm test -w @zyo/web`) must be green before the deploy.

## 5. Upgrading later, through the multisig

1. Build the new version; `node scripts/sync-idl.mjs --check` against the reviewed commit.
2. Write the buffer with any funded key: `solana program write-buffer target/deploy/oilskin.so --url <rpc>`.
3. Hand the buffer to the vault: `solana program set-buffer-authority <buffer> --new-buffer-authority <squads vault>`.
4. In Squads, propose a transaction with the BPF Upgradeable Loader **Upgrade** instruction (program, buffer,
   spill account, authority = the vault); members approve to threshold; execute.
5. `node solana/scripts/authority.mjs --program <program id> --expect <squads vault>` must still say DONE (the
   authority did not move) and show the new deploy slot.

What this page does not cover: making the program immutable (`--final`) — it would remove the ability to fix a
bug that traps users' positions, so it is not the plan; and the Squads member/threshold policy, which is the
founder's decision and lives in `DEPLOYMENTS.md` once made.
