// The lookup-table script (solana/scripts/lookup-table.mjs): the address list is shared's, whole, with nothing
// per-user in it; the commands chunk the way the CLI and a legacy transaction need; the on-chain layout decodes;
// and --verify tells complete, short, absent and deactivated apart with the right exit code. Nothing here
// touches a network: the RPC is a fake that serves a synthetic table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { CCTP_V2_SOLANA, CCTP_V2_SOLANA_RECEIVE, KAMINO_ZCASH_MARKET, SOLANA_PROGRAMS } from "@zyo/shared";
import {
  EXTEND_CHUNK,
  INSTRUCTIONS_SYSVAR,
  LOOKUP_TABLE_META_SIZE,
  LOOKUP_TABLE_PROGRAM,
  SYSTEM_PROGRAM,
  createCommand,
  decodeLookupTable,
  extendCommands,
  lendingMarketAuthority,
  main,
  requiredAddresses,
  verify,
} from "../scripts/lookup-table.mjs";

const required = requiredAddresses();
const addressesOf = (list) => list.map((x) => x.address);

test("the list is every static account of the burn and the delivery, from shared, deduplicated, all valid keys", () => {
  const set = new Set(addressesOf(required));
  assert.equal(set.size, required.length, "no duplicates");
  assert.ok(required.length >= 30, `expected at least 30 addresses, got ${required.length}`);
  for (const x of required) assert.doesNotThrow(() => new PublicKey(x.address), x.what);
  // Circle, both sides — every recorded PDA and both programs
  for (const [k, a] of Object.entries(CCTP_V2_SOLANA.pdas)) assert.ok(set.has(a), `send-side pda ${k}`);
  for (const a of Object.values(CCTP_V2_SOLANA.programs)) assert.ok(set.has(a), "program");
  for (const k of ["messageTransmitterAuthority", "tokenPairBaseUsdc", "custodyUsdc", "feeRecipientUsdcAta", "messageTransmitterEventAuthority", "tokenMessengerEventAuthority"]) {
    assert.ok(set.has(CCTP_V2_SOLANA_RECEIVE.pdas[k]), `receive-side pda ${k}`);
  }
  // Kamino's context
  const r = KAMINO_ZCASH_MARKET.reserves;
  for (const a of [SOLANA_PROGRAMS.klend, SOLANA_PROGRAMS.farms, SOLANA_PROGRAMS.splToken, KAMINO_ZCASH_MARKET.lendingMarket, KAMINO_ZCASH_MARKET.scopeOraclePrices, r.ZEC.address, r.USDC.address, r.ZEC.mint, r.USDC.mint, r.ZEC.liquiditySupplyVault, r.ZEC.collateralMint, r.ZEC.collateralSupplyVault, r.USDC.liquiditySupplyVault, r.USDC.liquidityFeeVault, SYSTEM_PROGRAM, INSTRUCTIONS_SYSVAR]) {
    assert.ok(set.has(a), a);
  }
  assert.ok(set.has(lendingMarketAuthority()));
});

test("nothing per-user or per-message is in the table: Circle's fee recipient WALLET is not (only its token account is), and the market owner is not", () => {
  const set = new Set(addressesOf(required));
  assert.ok(!set.has(CCTP_V2_SOLANA_RECEIVE.pdas.feeRecipient), "the wallet is not an account either transaction touches");
  assert.ok(!set.has(KAMINO_ZCASH_MARKET.lendingMarketOwner), "the market's owner signs nothing here");
  assert.ok(!set.has(KAMINO_ZCASH_MARKET.scopeOracleMappings), "the mappings account is read by the facts script, not by either transaction");
});

test("the market authority is klend's [\"lma\", market] PDA: off the curve, not the market itself", () => {
  const lma = lendingMarketAuthority();
  assert.notEqual(lma, KAMINO_ZCASH_MARKET.lendingMarket);
  assert.equal(PublicKey.isOnCurve(new PublicKey(lma).toBytes()), false);
  const [again] = PublicKey.findProgramAddressSync([Buffer.from("lma"), new PublicKey(KAMINO_ZCASH_MARKET.lendingMarket).toBuffer()], new PublicKey(SOLANA_PROGRAMS.klend));
  assert.equal(again.toBase58(), lma, "the same derivation the localnet spec makes");
});

test("the commands: one create, then extends of at most EXTEND_CHUNK comma-separated addresses covering the whole list, with the URL on each", () => {
  const url = "https://api.devnet.solana.com";
  assert.match(createCommand(url), /^solana address-lookup-table create --authority <AUTHORITY_KEYPAIR> --payer <PAYER_KEYPAIR> --url https:\/\/api\.devnet\.solana\.com$/);
  const cmds = extendCommands("TABLE111", addressesOf(required), url);
  assert.equal(cmds.length, Math.ceil(required.length / EXTEND_CHUNK));
  const covered = [];
  for (const c of cmds) {
    const m = c.match(/^solana address-lookup-table extend TABLE111 --addresses ([^ ]+) --url https:\/\/api\.devnet\.solana\.com$/);
    assert.ok(m, c);
    const list = m[1].split(",");
    assert.ok(list.length >= 1 && list.length <= EXTEND_CHUNK, `${list.length} in one extend`);
    covered.push(...list);
  }
  assert.deepEqual(covered, addressesOf(required), "every address, in order, exactly once");
  assert.equal(EXTEND_CHUNK, 12, "the runbook's 'up to ~12 per call'");
});

/** A synthetic on-chain table: the 56-byte header, then the addresses. */
function tableAccount(addresses, opts = {}) {
  const head = Buffer.alloc(LOOKUP_TABLE_META_SIZE);
  head.writeUInt32LE(opts.typeIndex ?? 1, 0);
  head.writeBigUInt64LE(opts.deactivationSlot ?? (1n << 64n) - 1n, 4);
  head.writeBigUInt64LE(opts.lastExtendedSlot ?? 447_000_000n, 12);
  head[20] = opts.startIndex ?? 0;
  if (opts.authority !== null) {
    head[21] = 1;
    new PublicKey(opts.authority ?? SOLANA_PROGRAMS.klend).toBuffer().copy(head, 22);
  }
  return Buffer.concat([head, ...addresses.map((a) => new PublicKey(a).toBuffer())]);
}

test("the on-chain layout decodes: active flag, last extended slot, authority, every address; a wrong type index or a short buffer is refused", () => {
  const list = addressesOf(required).slice(0, 5);
  const t = decodeLookupTable(tableAccount(list, { authority: KAMINO_ZCASH_MARKET.lendingMarketOwner, lastExtendedSlot: 123n }));
  assert.equal(t.active, true);
  assert.equal(t.lastExtendedSlot, 123n);
  assert.equal(t.authority, KAMINO_ZCASH_MARKET.lendingMarketOwner);
  assert.deepEqual(t.addresses, list);
  const frozen = decodeLookupTable(tableAccount(list, { authority: null }));
  assert.equal(frozen.authority, null);
  const dead = decodeLookupTable(tableAccount(list, { deactivationSlot: 5n }));
  assert.equal(dead.active, false);
  assert.throws(() => decodeLookupTable(tableAccount(list, { typeIndex: 0 })), /not a lookup table \(type index 0/);
  assert.throws(() => decodeLookupTable(Buffer.alloc(10)), /under the 56-byte header/);
});

/** A fake RPC serving one account. */
function fakeRpc(account) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.method, "getAccountInfo");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 448_000_000 }, value: account } }), { status: 200 });
  };
}
const served = (data, owner = LOOKUP_TABLE_PROGRAM) => ({ owner, executable: false, lamports: 1, data: [data.toString("base64"), "base64"] });
const TABLE = "AddressLookupTab1e1111111111111111111111111";

test("--verify: COMPLETE (exit 0) when every required address is held, extras listed; SHORT (exit 1) names the missing and prints the extends for them", async () => {
  const all = addressesOf(required);
  const complete = await verify("http://rpc", TABLE, fakeRpc(served(tableAccount([...all, SYSTEM_PROGRAM === all[0] ? all[1] : KAMINO_ZCASH_MARKET.lendingMarketOwner]))));
  assert.equal(complete.status, "complete");
  assert.deepEqual(complete.missing, []);
  assert.deepEqual(complete.extra, [KAMINO_ZCASH_MARKET.lendingMarketOwner]);
  const lines = [];
  assert.equal(await main(["--verify", TABLE, "--rpc", "http://rpc"], fakeRpc(served(tableAccount(all))), (l) => lines.push(l)), 0);
  assert.ok(lines.some((l) => /^COMPLETE:/.test(l)), lines.join("\n"));

  const short = await verify("http://rpc", TABLE, fakeRpc(served(tableAccount(all.slice(0, all.length - 3)))));
  assert.equal(short.status, "short");
  assert.deepEqual(short.missing.map((x) => x.address), all.slice(-3));
  const out = [];
  assert.equal(await main(["--verify", TABLE, "--rpc", "http://rpc"], fakeRpc(served(tableAccount(all.slice(0, all.length - 3)))), (l) => out.push(l)), 1);
  assert.ok(out.some((l) => /^SHORT:/.test(l)));
  const extend = out.find((l) => /address-lookup-table extend/.test(l));
  assert.ok(extend && extend.includes(all.slice(-3).join(",")), extend);
});

test("--verify: ABSENT (exit 2) for no account, another owner, a deactivated table, or bytes that are not a table", async () => {
  const all = addressesOf(required);
  const cases = [
    [null, /no account/],
    [served(tableAccount(all), SOLANA_PROGRAMS.klend), /owned by .*, not the lookup-table program/],
    [served(tableAccount(all, { deactivationSlot: 1n })), /deactivated at slot 1/],
    [served(Buffer.alloc(10)), /under the 56-byte header/],
  ];
  for (const [acct, re] of cases) {
    const v = await verify("http://rpc", TABLE, fakeRpc(acct));
    assert.equal(v.status, "absent");
    assert.match(v.reason, re);
    const out = [];
    assert.equal(await main(["--verify", TABLE, "--rpc", "http://rpc"], fakeRpc(acct), (l) => out.push(l)), 2);
  }
  const bad = await verify("http://rpc", "not-a-key");
  assert.equal(bad.status, "absent");
});

test("with no arguments the script prints the list and the commands, never touching the network; --json is the same list", async () => {
  const out = [];
  const code = await main([], async () => {
    throw new Error("the network must not be touched");
  }, (l) => out.push(l));
  assert.equal(code, 0);
  const text = out.join("\n");
  for (const x of required) assert.ok(text.includes(x.address), x.what);
  assert.ok(/address-lookup-table create/.test(text));
  assert.equal((text.match(/address-lookup-table extend <TABLE>/g) ?? []).length, Math.ceil(required.length / EXTEND_CHUNK));
  assert.ok(/nothing in this repository signs them/.test(text));
  const json = [];
  assert.equal(await main(["--json"], undefined, (l) => json.push(l)), 0);
  assert.deepEqual(JSON.parse(json.join("\n")).addresses, required);
});
