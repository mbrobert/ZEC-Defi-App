// The web's Solana decoders against the mainnet capture (the yield service's fixture, slot 446,506,191) and the
// program's own account layouts; PDAs pinned to the capture's obligation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { KAMINO_ZCASH_MARKET, SOLANA_PROGRAMS } from "@zyo/shared";
import { accountPda, ata, grantPda, lendingMarketAuthority, obligationPda, PK, userMetadataPda } from "../lib/solana/addresses";
import { OILSKIN_SOLANA_IDL } from "../lib/solana/idl.generated";
import { ctokensToLiquidity, decodeGrant, decodeObligation, decodeReserveExchange, decodeTokenAccount, decodeUserAccount, grantRemaining, GRANT_LEN, USER_ACCOUNT_LEN } from "../lib/solana/reads";

const fixture = JSON.parse(readFileSync(join(__dirname, "../../services/yield/test/fixtures/solana-mainnet-2026-09-12.json"), "utf8")) as { slot: number; accounts: Record<string, { address: string; owner: string; dataBase64: string }> };
const bytes = (k: string) => Uint8Array.from(Buffer.from(fixture.accounts[k]!.dataBase64, "base64"));

test("the capture's top borrower decodes: a ZEC deposit, a USDC debt, a cached health factor; the obligation PDA is the one klend derives for that owner", () => {
  const ob = decodeObligation(bytes("obligationTopBorrower"));
  assert.ok(ob.zecDepositedCtokens > 0n);
  assert.ok(ob.usdcBorrowedUnits > 0n);
  assert.equal(ob.hasDebt, true);
  assert.ok(ob.cachedHf! > 1 && ob.cachedHf! < 3, `cached HF ${ob.cachedHf}`);
  assert.equal(obligationPda(ob.owner).toBase58(), fixture.accounts.obligationTopBorrower!.address, "seeds [0, 0, owner, market, default, default] under klend");
  assert.deepEqual([...bytes("obligationTopBorrower").subarray(0, 8)], [...createHash("sha256").update("account:Obligation").digest().subarray(0, 8)]);
  const r = decodeReserveExchange(bytes("zecReserve"));
  assert.equal(r.borrowedUnits, 0n);
  assert.equal(r.collateralTotalSupply, r.availableUnits, "1:1 while nothing is lent");
  assert.equal(ctokensToLiquidity(ob.zecDepositedCtokens, r), ob.zecDepositedCtokens);
  assert.equal(ctokensToLiquidity(100n, { availableUnits: 200n, borrowedUnits: 0n, collateralTotalSupply: 100n }), 200n, "a 2:1 exchange rate doubles");
});

test("UserAccount and Grant round-trip through the program's layouts (built here from the field order, decoded by the web)", () => {
  const owner = Keypair.generate().publicKey;
  const program = new PublicKey(OILSKIN_SOLANA_IDL.address);
  const account = accountPda(program, owner);
  const u = new Uint8Array(USER_ACCOUNT_LEN);
  u.set(OILSKIN_SOLANA_IDL.accounts.UserAccount, 0);
  u.set(owner.toBytes(), 8);
  u[40] = 254;
  u[41] = 1;
  new DataView(u.buffer).setBigUint64(42, 7n, true);
  u.set(obligationPda(account).toBytes(), 50);
  new DataView(u.buffer).setBigUint64(82, 446_600_000n, true);
  const ua = decodeUserAccount(u);
  assert.equal(ua.owner.toBase58(), owner.toBase58());
  assert.equal(ua.bump, 254);
  assert.equal(ua.grantEpoch, 7n);
  assert.equal(ua.obligation.toBase58(), obligationPda(account).toBase58());
  assert.equal(ua.createdSlot, 446_600_000n);
  assert.throws(() => decodeUserAccount(u.subarray(0, 100)), /UserAccount/);

  const keeper = Keypair.generate().publicKey;
  const g = new Uint8Array(GRANT_LEN);
  g.set(OILSKIN_SOLANA_IDL.accounts.Grant, 0);
  g.set(account.toBytes(), 8);
  g.set(keeper.toBytes(), 40);
  g[72] = 255;
  g[73] = 1;
  const dv = new DataView(g.buffer);
  dv.setBigUint64(74, 7n, true); // epoch
  dv.setBigInt64(82, 1_790_000_000n, true); // expiry
  dv.setBigUint64(90, 86_400n, true); // period
  dv.setBigInt64(98, 1_789_000_000n, true); // period start
  dv.setBigUint64(106, 5_000_000_000n, true); // repay per period
  dv.setBigUint64(114, 1_000_000_000n, true); // repay spent
  dv.setBigUint64(122, 500_000_000n, true); // sell per period
  dv.setBigUint64(130, 0n, true);
  dv.setUint16(138, 200, true);
  g[140] = 0b1111;
  const gr = decodeGrant(g);
  assert.equal(gr.keeper.toBase58(), keeper.toBase58());
  assert.equal(gr.epoch, 7n);
  assert.equal(gr.repayUsdcSpent, 1_000_000_000n);
  assert.equal(gr.maxSellSlippageBps, 200);
  assert.equal(gr.allowedRungs, 15);
  const live = grantRemaining(gr, 7n, 1_789_050_000n);
  assert.equal(live.live, true);
  assert.equal(live.repayLeft, 4_000_000_000n);
  assert.equal(live.rolled, false);
  assert.equal(grantRemaining(gr, 8n, 1_789_050_000n).live, false, "an older epoch is not live");
  assert.equal(grantRemaining(gr, 7n, 1_790_000_001n).live, false, "expired");
  const rolled = grantRemaining(gr, 7n, 1_789_000_000n + 90_000n);
  assert.equal(rolled.rolled, true);
  assert.equal(rolled.repayLeft, 5_000_000_000n, "a new period starts full");
});

test("SPL token accounts: amount, delegate and delegated amount; an absent account reads as empty", () => {
  const t = new Uint8Array(165);
  const dv = new DataView(t.buffer);
  dv.setBigUint64(64, 123_456n, true);
  dv.setUint32(72, 1, true);
  const delegate = Keypair.generate().publicKey;
  t.set(delegate.toBytes(), 76);
  dv.setBigUint64(121, 1_000n, true);
  const v = decodeTokenAccount(t);
  assert.equal(v.amount, 123_456n);
  assert.equal(v.delegate!.toBase58(), delegate.toBase58());
  assert.equal(v.delegatedAmount, 1_000n);
  assert.deepEqual(decodeTokenAccount(null), { amount: 0n, delegate: null, delegatedAmount: 0n });
});

test("the addresses are shared's, and the klend PDAs derive with the documented seeds", () => {
  assert.equal(PK.market.toBase58(), KAMINO_ZCASH_MARKET.lendingMarket);
  assert.equal(PK.klend.toBase58(), SOLANA_PROGRAMS.klend);
  assert.equal(PK.zecReserve.toBase58(), KAMINO_ZCASH_MARKET.reserves.ZEC.address);
  const owner = Keypair.generate().publicKey;
  const program = new PublicKey(OILSKIN_SOLANA_IDL.address);
  const account = accountPda(program, owner);
  assert.equal(PublicKey.isOnCurve(account.toBytes()), false, "a PDA");
  assert.notEqual(grantPda(program, account, owner).toBase58(), grantPda(program, account, Keypair.generate().publicKey).toBase58());
  assert.equal(userMetadataPda(account).toBase58(), PublicKey.findProgramAddressSync([Buffer.from("user_meta"), account.toBuffer()], PK.klend)[0].toBase58());
  assert.equal(lendingMarketAuthority().toBase58(), PublicKey.findProgramAddressSync([Buffer.from("lma"), PK.market.toBuffer()], PK.klend)[0].toBase58());
  assert.equal(ata(account, PK.zecMint).toBase58(), PublicKey.findProgramAddressSync([account.toBuffer(), PK.tokenProgram.toBuffer(), PK.zecMint.toBuffer()], PK.associatedToken)[0].toBase58());
});
