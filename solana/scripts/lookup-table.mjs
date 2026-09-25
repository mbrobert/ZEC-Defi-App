#!/usr/bin/env node
// The address lookup table both cross-chain transactions ride (docs/SOLANA-DEPLOY.md §2b; CROSSCHAIN-RUNBOOK
// §4 item 1): `deposit_for_burn` measured 1,422 bytes and the keeper's `receive_message` 1,264 bytes as legacy
// transactions against the 1,232-byte limit, so both are v0 transactions with one table created once at deploy.
//
// Read-only. Never signs, never sends. It prints the exact address list and the CLI commands the founder runs
// in his terminal, and it verifies a table that exists. Every address comes from `@zyo/shared` (pinned to
// docs/VERIFIED-SOLANA-FACTS.md Addenda 3 and 4) except one PDA derived here with the seed shared records.
//
//   node solana/scripts/lookup-table.mjs                          → the list, what each address is, the commands
//   node solana/scripts/lookup-table.mjs --json                   → the list as JSON
//   node solana/scripts/lookup-table.mjs --verify <table> [--rpc <url>]
//       → reads the table; exit 0 when it holds every required address (extras are listed, not refused),
//         exit 1 when it is short (the missing addresses are printed, and the extend commands for them),
//         exit 2 when the account is absent, deactivated, or not a lookup table.
//
// What a deploy-time table cannot hold, and so rides as static keys in each transaction: the user's Account
// PDA, its Kamino obligation, its USDC token account and Circle's per-account denylist PDA (the burn); the
// fresh `MessageSent` event keypair (the burn); the payer, the caller, the per-message `used_nonce` PDA and
// the recipient token account (the delivery). Those are per user or per message; a table is for the rest.
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { CCTP_V2_SOLANA, CCTP_V2_SOLANA_RECEIVE, KAMINO_ZCASH_MARKET, KLEND_SEEDS, SOLANA_PROGRAMS } from "@zyo/shared";
import { DEFAULT_RPC, base58, isBase58Key, rpc } from "./authority.mjs";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const INSTRUCTIONS_SYSVAR = "Sysvar1nstructions1111111111111111111111111";
export const LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
/** One `extend` per chunk: a legacy transaction cannot carry many more addresses than this either. */
export const EXTEND_CHUNK = 12;
/** The on-chain `LookupTableMeta` is 56 bytes; the addresses follow, 32 bytes each. */
export const LOOKUP_TABLE_META_SIZE = 56;
const U64_MAX = (1n << 64n) - 1n;

/** klend's `["lma", market]` PDA — the only address here that is derived rather than read from shared. */
export function lendingMarketAuthority() {
  return PublicKey.findProgramAddressSync([Buffer.from(KLEND_SEEDS.lendingMarketAuthority), new PublicKey(KAMINO_ZCASH_MARKET.lendingMarket).toBuffer()], new PublicKey(SOLANA_PROGRAMS.klend))[0].toBase58();
}

/**
 * Every STATIC account of the two transactions, deduplicated, in the order the localnet specs list them
 * (`solana/tests/crosschain.spec.ts`: the burn's `kamino` and `cctp` objects; the delivery's `ixReceiveMessage`
 * keys less the per-message ones). `side` says which transaction first needs it; several serve both.
 */
export function requiredAddresses() {
  const r = KAMINO_ZCASH_MARKET.reserves;
  const rows = [
    // deposit_for_burn — Kamino's refresh context
    ["burn", "Kamino Lend program", SOLANA_PROGRAMS.klend],
    ["burn", "ZCASH lending market", KAMINO_ZCASH_MARKET.lendingMarket],
    ["burn", 'lending market authority (PDA ["lma", market])', lendingMarketAuthority()],
    ["burn", "ZEC reserve", r.ZEC.address],
    ["burn", "USDC reserve", r.USDC.address],
    ["burn", "ZEC mint", r.ZEC.mint],
    ["burn", "USDC mint", r.USDC.mint],
    ["burn", "ZEC liquidity supply vault", r.ZEC.liquiditySupplyVault],
    ["burn", "ZEC collateral mint", r.ZEC.collateralMint],
    ["burn", "ZEC collateral supply vault", r.ZEC.collateralSupplyVault],
    ["burn", "USDC liquidity supply vault", r.USDC.liquiditySupplyVault],
    ["burn", "USDC fee vault", r.USDC.liquidityFeeVault],
    ["burn", "Scope OraclePrices", KAMINO_ZCASH_MARKET.scopeOraclePrices],
    ["burn", "Kamino Farms program", SOLANA_PROGRAMS.farms],
    ["burn", "Instructions sysvar", INSTRUCTIONS_SYSVAR],
    ["burn", "SPL Token program", SOLANA_PROGRAMS.splToken],
    ["burn", "System program", SYSTEM_PROGRAM],
    // deposit_for_burn — Circle, send side
    ["burn", "TokenMessengerMinterV2 program", CCTP_V2_SOLANA.programs.tokenMessengerMinterV2],
    ["burn", "MessageTransmitterV2 program", CCTP_V2_SOLANA.programs.messageTransmitterV2],
    ["burn", "sender authority PDA", CCTP_V2_SOLANA.pdas.senderAuthority],
    ["burn", "message_transmitter", CCTP_V2_SOLANA.pdas.messageTransmitter],
    ["burn", "token_messenger", CCTP_V2_SOLANA.pdas.tokenMessenger],
    ["burn", "remote_token_messenger (domain 6, Base)", CCTP_V2_SOLANA.pdas.remoteTokenMessengerBase],
    ["burn", "token_minter", CCTP_V2_SOLANA.pdas.tokenMinter],
    ["burn", "local_token (USDC)", CCTP_V2_SOLANA.pdas.localTokenUsdc],
    ["burn", "token messenger event authority", CCTP_V2_SOLANA_RECEIVE.pdas.tokenMessengerEventAuthority],
    // receive_message — Circle, receive side (the programs, token_messenger, remote_token_messenger, token_minter,
    // local_token, the token program, the system program and the messenger's event authority are already above)
    ["delivery", "message_transmitter_authority (for the token messenger)", CCTP_V2_SOLANA_RECEIVE.pdas.messageTransmitterAuthority],
    ["delivery", "message transmitter event authority", CCTP_V2_SOLANA_RECEIVE.pdas.messageTransmitterEventAuthority],
    ["delivery", "token_pair (domain 6, Base USDC)", CCTP_V2_SOLANA_RECEIVE.pdas.tokenPairBaseUsdc],
    ["delivery", "Circle's fee recipient USDC token account", CCTP_V2_SOLANA_RECEIVE.pdas.feeRecipientUsdcAta],
    ["delivery", "custody token account (USDC)", CCTP_V2_SOLANA_RECEIVE.pdas.custodyUsdc],
  ];
  const seen = new Set();
  const out = [];
  for (const [side, what, address] of rows) {
    if (!isBase58Key(address)) throw new Error(`${what}: ${address} is not a base58 key`);
    if (seen.has(address)) continue;
    seen.add(address);
    out.push({ side, what, address });
  }
  return out;
}

export function createCommand(url) {
  return `solana address-lookup-table create --authority <AUTHORITY_KEYPAIR> --payer <PAYER_KEYPAIR> --url ${url}`;
}

/** One `extend` per chunk of `EXTEND_CHUNK` addresses, comma-separated as the CLI takes them. */
export function extendCommands(table, addresses, url, chunk = EXTEND_CHUNK) {
  const cmds = [];
  for (let i = 0; i < addresses.length; i += chunk) {
    cmds.push(`solana address-lookup-table extend ${table} --addresses ${addresses.slice(i, i + chunk).join(",")} --url ${url}`);
  }
  return cmds;
}

/**
 * The lookup-table program's account layout (solana `address-lookup-table` `LookupTableMeta`): u32 type index
 * (1 = a table) · u64 deactivation slot (u64::MAX = active) · u64 last extended slot · u8 last extended slot's
 * start index · Option<Pubkey> authority (1 + 32) · 2 bytes of padding = 56, then the addresses, 32 bytes each.
 */
export function decodeLookupTable(data) {
  if (!(data instanceof Uint8Array) || data.length < LOOKUP_TABLE_META_SIZE) throw new Error(`lookup table account is ${data?.length ?? "?"} bytes, under the ${LOOKUP_TABLE_META_SIZE}-byte header`);
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const typeIndex = b.readUInt32LE(0);
  if (typeIndex !== 1) throw new Error(`not a lookup table (type index ${typeIndex}, expected 1)`);
  const deactivationSlot = b.readBigUInt64LE(4);
  const lastExtendedSlot = b.readBigUInt64LE(12);
  const lastExtendedStartIndex = b[20];
  const authority = b[21] === 1 ? base58(b.subarray(22, 54)) : null;
  const n = Math.floor((b.length - LOOKUP_TABLE_META_SIZE) / 32);
  const addresses = [];
  for (let i = 0; i < n; i++) addresses.push(base58(b.subarray(LOOKUP_TABLE_META_SIZE + 32 * i, LOOKUP_TABLE_META_SIZE + 32 * (i + 1))));
  return { active: deactivationSlot === U64_MAX, deactivationSlot, lastExtendedSlot, lastExtendedStartIndex, authority, addresses };
}

/** Read a table and compare it with what the two transactions need. */
export async function verify(url, table, fetchImpl = fetch) {
  if (!isBase58Key(table)) return { status: "absent", reason: `${table} is not a base58 key` };
  const r = await rpc(url, "getAccountInfo", [table, { encoding: "base64", commitment: "confirmed" }], fetchImpl);
  if (!r || !r.value) return { status: "absent", reason: `${table}: no account on ${url}` };
  if (r.value.owner !== LOOKUP_TABLE_PROGRAM) return { status: "absent", reason: `${table}: owned by ${r.value.owner}, not the lookup-table program` };
  let meta;
  try {
    meta = decodeLookupTable(Buffer.from(r.value.data[0], "base64"));
  } catch (e) {
    return { status: "absent", reason: `${table}: ${e.message}` };
  }
  if (!meta.active) return { status: "absent", reason: `${table}: deactivated at slot ${meta.deactivationSlot} — a deactivated table cannot be used or extended; create a new one` };
  const present = new Set(meta.addresses);
  const required = requiredAddresses();
  const missing = required.filter((x) => !present.has(x.address));
  const extra = meta.addresses.filter((a) => !required.some((x) => x.address === a));
  return { status: missing.length ? "short" : "complete", meta, required, missing, extra, readSlot: r.context?.slot ?? null };
}

export async function main(argv, fetchImpl = fetch, out = console.log) {
  const arg = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = arg("--rpc") ?? DEFAULT_RPC;
  const table = arg("--verify");
  const required = requiredAddresses();

  if (argv.includes("--json")) {
    out(JSON.stringify({ chunk: EXTEND_CHUNK, addresses: required }, null, 2));
    return 0;
  }

  if (!table) {
    out(`The address lookup table both cross-chain transactions ride — ${required.length} addresses, from @zyo/shared`);
    out("(docs/VERIFIED-SOLANA-FACTS.md Addenda 3 and 4) plus the klend market authority derived with the recorded seed.");
    out("");
    const w = Math.max(...required.map((x) => x.what.length));
    for (const x of required) out(`  ${x.side.padEnd(8)} ${x.what.padEnd(w)}  ${x.address}`);
    out("");
    out("The founder runs these in his terminal, with a funded key; nothing in this repository signs them. The");
    out("`create` command prints the table's address — put it in place of <TABLE> below, then extend, wait a slot");
    out("or two after the last extend, verify with --verify, and record the address in docs/DEPLOYMENTS.md and the");
    out("keeper's CCTP_LOOKUP_TABLE:");
    out("");
    out(`  ${createCommand(url)}`);
    for (const c of extendCommands("<TABLE>", required.map((x) => x.address), url)) out(`  ${c}`);
    return 0;
  }

  const v = await verify(url, table, fetchImpl);
  if (v.status === "absent") {
    out(`ABSENT: ${v.reason}`);
    return 2;
  }
  out(`table              ${table}`);
  out(`authority          ${v.meta.authority ?? "NONE — frozen"}`);
  out(`addresses          ${v.meta.addresses.length} held, ${v.required.length} required, ${v.missing.length} missing, ${v.extra.length} extra`);
  out(`last extended      slot ${v.meta.lastExtendedSlot}`);
  out(`read at slot       ${v.readSlot ?? "?"} (${url})`);
  if (v.extra.length) {
    out("");
    out("Extra (held but not needed by either transaction — harmless, listed so a reader can see what else was added):");
    for (const a of v.extra) out(`  ${a}`);
  }
  if (v.status === "complete") {
    out("");
    out("COMPLETE: every address the burn and the delivery need is in the table.");
    return 0;
  }
  out("");
  out("SHORT: these are missing —");
  for (const x of v.missing) out(`  ${x.side.padEnd(8)} ${x.what}  ${x.address}`);
  out("");
  out("Extend with (the founder, in his terminal), then wait a slot or two and re-run --verify:");
  for (const c of extendCommands(table, v.missing.map((x) => x.address), url)) out(`  ${c}`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`lookup-table: ${e.message}`);
      process.exit(1);
    }
  );
}
