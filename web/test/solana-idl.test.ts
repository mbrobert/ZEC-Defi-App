// The Solana instruction seam: lib/solana/idl.generated.ts equals the committed solana/idl/oilskin.json, and every
// hand-encoded builder puts the IDL's accounts in the IDL's order with the IDL's flags and fixed addresses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { OILSKIN_SOLANA_IDL } from "../lib/solana/idl.generated";
import { accountPda, grantPda, lendingMarketAuthority, PK } from "../lib/solana/addresses";
import { encodeGrantParams, ixBorrow, ixClosePosition, ixDeposit, ixGrant, ixInitAccount, ixRepay, ixRevoke, ixRevokeAll, ixTransferOut, ixWithdraw, kaminoMetas, u64le, anchorErrorName } from "../lib/solana/instructions";

const idlRaw = readFileSync(join(__dirname, "../../solana/idl/oilskin.json"), "utf8");
const idl = JSON.parse(idlRaw);
const flat = (accs: any[], p = ""): { name: string; writable: boolean; signer: boolean; address: string | null }[] => accs.flatMap((a) => (a.accounts ? flat(a.accounts, p + a.name + ".") : [{ name: p + a.name, writable: !!a.writable, signer: !!a.signer, address: a.address ?? null }]));

test("the generated file is the committed IDL: hash, discriminators, account order and flags, argument types, errors", () => {
  assert.equal(OILSKIN_SOLANA_IDL.sha256, createHash("sha256").update(idlRaw).digest("hex"), "run: node scripts/sync-solana-idl.mjs");
  assert.equal(OILSKIN_SOLANA_IDL.address, idl.address);
  for (const ix of idl.instructions) {
    const g = (OILSKIN_SOLANA_IDL.instructions as any)[ix.name];
    assert.ok(g, `instruction ${ix.name} missing from the generated file`);
    assert.deepEqual([...g.discriminator], ix.discriminator);
    assert.deepEqual(g.accounts, flat(ix.accounts));
  }
  assert.deepEqual([...OILSKIN_SOLANA_IDL.accounts.UserAccount], idl.accounts.find((a: any) => a.name === "UserAccount").discriminator);
  assert.deepEqual([...OILSKIN_SOLANA_IDL.accounts.Grant], idl.accounts.find((a: any) => a.name === "Grant").discriminator);
  assert.equal(OILSKIN_SOLANA_IDL.errors.length, idl.errors.length);
  assert.ok(OILSKIN_SOLANA_IDL.errors.some((e) => e.name === "EntryHfTooLow" && e.code === 6002));
});

const program = new PublicKey(idl.address);
const owner = Keypair.generate().publicKey;
const keeper = Keypair.generate().publicKey;
const account = accountPda(program, owner);
const k = { program, owner, account };
const grant = grantPda(program, account, keeper);
const params = { expiryTs: 1_789_900_000n, periodSecs: 86_400n, repayUsdcPerPeriod: 5_000_000_000n, sellZecPerPeriod: 500_000_000n, maxSellSlippageBps: 200, allowedRungs: 0b1111 };

/** Each builder's keys must be the IDL's accounts, in order, with the IDL's flags; fixed addresses must match. */
const check = (name: string, ix: ReturnType<typeof ixInitAccount>) => {
  const spec = (OILSKIN_SOLANA_IDL.instructions as any)[name];
  assert.equal(ix.programId.toBase58(), idl.address);
  assert.deepEqual([...ix.data.subarray(0, 8)], [...spec.discriminator], `${name} discriminator`);
  assert.equal(ix.keys.length, spec.accounts.length, `${name}: ${ix.keys.length} keys vs ${spec.accounts.length} in the IDL`);
  spec.accounts.forEach((a: any, i: number) => {
    const key = ix.keys[i]!;
    assert.equal(key.isWritable, a.writable, `${name}[${i}] ${a.name} writable`);
    assert.equal(key.isSigner, a.signer, `${name}[${i}] ${a.name} signer`);
    if (a.address) assert.equal(key.pubkey.toBase58(), a.address, `${name}[${i}] ${a.name} address`);
  });
};

test("every owner instruction encodes to the IDL: accounts, flags, fixed addresses, data lengths", () => {
  check("init_account", ixInitAccount(k));
  check("deposit", ixDeposit(k, 10n * 100_000_000n));
  check("borrow", ixBorrow(k, 3_990_000_000n));
  check("repay", ixRepay(k, 1n));
  check("withdraw", ixWithdraw(k, 1n));
  check("close_position", ixClosePosition(k));
  check("transfer_out", ixTransferOut(k, PK.usdcMint, 1n));
  check("grant", ixGrant(k, keeper, grant, params));
  check("revoke", ixRevoke(k, keeper, grant));
  check("revoke_all", ixRevokeAll(k));
  assert.equal(ixInitAccount(k).data.length, 8);
  assert.equal(ixDeposit(k, 1n).data.length, 16);
  assert.equal(ixGrant(k, keeper, grant, params).data.length, 8 + 32 + 35, "disc + keeper pubkey + GrantParams (i64 u64 u64 u64 u16 u8)");
  assert.equal(ixRevoke(k, keeper, grant).data.length, 40);
  // the keeper pubkey rides right after the discriminator
  assert.deepEqual([...ixGrant(k, keeper, grant, params).data.subarray(8, 40)], [...keeper.toBytes()]);
  // the composite is the same 16 accounts every Kamino-touching instruction carries
  assert.equal(kaminoMetas().length, 16);
  assert.equal(kaminoMetas()[2]!.pubkey.toBase58(), lendingMarketAuthority().toBase58());
});

test("GrantParams follows the IDL's field order, little-endian; u64 refuses negatives and overflow", () => {
  const fields = OILSKIN_SOLANA_IDL.types.GrantParams.map(([n]) => n);
  assert.deepEqual(fields, ["expiry_ts", "period_secs", "repay_usdc_per_period", "sell_zec_per_period", "max_sell_slippage_bps", "allowed_rungs"]);
  const b = encodeGrantParams(params);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  assert.equal(dv.getBigInt64(0, true), params.expiryTs);
  assert.equal(dv.getBigUint64(8, true), params.periodSecs);
  assert.equal(dv.getBigUint64(16, true), params.repayUsdcPerPeriod);
  assert.equal(dv.getBigUint64(24, true), params.sellZecPerPeriod);
  assert.equal(dv.getUint16(32, true), 200);
  assert.equal(b[34], 0b1111);
  assert.throws(() => u64le(-1n), RangeError);
  assert.throws(() => u64le(1n << 64n), RangeError);
});

test("anchor error names are read from logs by name or by custom code", () => {
  assert.equal(anchorErrorName(["Program log: AnchorError occurred. Error Code: EntryHfTooLow. Error Number: 6002."]), "EntryHfTooLow");
  assert.equal(anchorErrorName(["Program failed: custom program error: 0x1788"]), "InsufficientUsdcToClose", "6024 = 0x1788");
  assert.equal(anchorErrorName(["Program failed: custom program error: 0x1778"]), "UnexpectedKaminoLayout", "6008 = 0x1778");
  assert.equal(anchorErrorName(["nothing here"]), null);
  assert.equal(anchorErrorName(null), null);
});
