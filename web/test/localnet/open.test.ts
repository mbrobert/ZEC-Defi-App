/**
 * THE SIGNED PATH — the web's own Solana library against the real program on localnet (BUILD-PLAN B5's last
 * item: "a wallet-driven run on localnet"). No browser: the wallet is a throwaway keypair implementing the
 * `SolanaWalletLike` the wizard hands to `runSolanaOpen`, so what runs is exactly what a wallet would sign —
 * the hand-encoded instructions pinned to the IDL, the plan from the demo snapshot, the step order, the
 * error decoding — and then the exit hatch, `runSolanaClose`, the same way. Everything else is the harness
 * the specs in solana/tests use: the validator scripts/localnet.sh starts (the ZCASH market cloned, Scope
 * mocked), its throwaway mint authorities, the mock oracle stamped fresh so klend's age checks pass.
 *
 * Its own directory, so the unit run's glob leaves it out; `npm run test:localnet -w @zyo/web` runs it (OILSKIN_LOCALNET=1,
 * and it skips by name without one) and `npm run status -- --all` runs it beside the localnet suite. Nothing here touches a real chain or a real key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction, type Signer } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { KAMINO_ZCASH_MARKET, SOLANA_PROGRAMS } from "@zyo/shared";
import { accountPda, PK } from "../../lib/solana/addresses";
import { closeSteps, runSolanaClose, runSolanaOpen, type SolanaEmit, type SolanaStepEvent, type SolanaWalletLike } from "../../lib/solana/execute";
import { grantRemaining, readSolanaPosition } from "../../lib/solana/reads";
import { openSteps, planSolanaOpen, solanaHfBounds } from "../../lib/solana/plan";
import { demoSolanaBorrow } from "../../lib/solana/yield";

const REPO = resolve(__dirname, "../../..");
const RPC = process.env.OILSKIN_LOCALNET_RPC ?? "http://127.0.0.1:8899";
const FIXTURES = join(REPO, "solana", process.env.OILSKIN_FIXTURES ?? "fixtures");
const ON = process.env.OILSKIN_LOCALNET === "1";
const ZEC_AUTHORITY = join(FIXTURES, "local-mint-authority.json");
const USDC_AUTHORITY = join(FIXTURES, "local-usdc-mint-authority.json");
const ONE_ZEC = 100_000_000n;
const ONE_USDC = 1_000_000n;

/** A test key from the harness's fixtures directory — never printed, never persisted anywhere else. */
const keyFile = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
/** The program id the localnet validator carries, as Anchor.toml declares it. */
function localnetProgramId(): PublicKey {
  const toml = readFileSync(join(REPO, "solana", "Anchor.toml"), "utf8");
  const m = toml.match(/\[programs\.localnet\][^[]*?oilskin\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/);
  if (!m) throw new Error("solana/Anchor.toml: no [programs.localnet] oilskin id");
  return new PublicKey(m[1]!);
}

/** The mock Scope program's `stamp_fresh(indices)` — discriminator and borsh from target/idl/mock_scope.json. */
function ixStampFresh(payer: PublicKey): TransactionInstruction {
  const R = KAMINO_ZCASH_MARKET.reserves;
  const indices = [R.ZEC.scopePriceChain[0]!, R.ZEC.scopeTwapChain[0]!, R.USDC.scopePriceChain[0]!, R.USDC.scopeTwapChain[0]!];
  const data = Buffer.alloc(8 + 4 + indices.length * 2);
  Buffer.from([45, 77, 150, 251, 156, 64, 230, 66]).copy(data, 0);
  data.writeUInt32LE(indices.length, 8);
  indices.forEach((i, n) => data.writeUInt16LE(i, 12 + n * 2));
  return new TransactionInstruction({
    programId: new PublicKey(SOLANA_PROGRAMS.scope),
    keys: [{ pubkey: PK.scopePrices, isSigner: false, isWritable: true }, { pubkey: payer, isSigner: true, isWritable: true }],
    data,
  });
}
/** `set_price(index, value, exp)` on the mock: the demo snapshot's ZEC price, so the plan and the program agree. */
function ixSetPrice(payer: PublicKey, index: number, value: bigint, exp: bigint): TransactionInstruction {
  const data = Buffer.alloc(8 + 2 + 8 + 8);
  Buffer.from([16, 19, 182, 8, 149, 83, 72, 181]).copy(data, 0);
  data.writeUInt16LE(index, 8);
  data.writeBigUInt64LE(value, 10);
  data.writeBigUInt64LE(exp, 18);
  return new TransactionInstruction({
    programId: new PublicKey(SOLANA_PROGRAMS.scope),
    keys: [{ pubkey: PK.scopePrices, isSigner: false, isWritable: true }, { pubkey: payer, isSigner: true, isWritable: true }],
    data,
  });
}

async function send(conn: Connection, ixs: TransactionInstruction[], signers: Signer[]): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/** What the wizard hands `runSolanaOpen`: sign with the keypair, send, hand back the signature. */
function keypairWallet(k: Keypair): SolanaWalletLike {
  return {
    publicKey: k.publicKey,
    sendTransaction: async (tx, conn) => {
      tx.sign(k);
      return conn.sendRawTransaction(tx.serialize());
    },
  };
}

const skip = !ON
  ? "OILSKIN_LOCALNET=1 not set"
  : !existsSync(ZEC_AUTHORITY) || !existsSync(USDC_AUTHORITY)
    ? `no mint authorities in ${FIXTURES} — start bash solana/scripts/localnet.sh`
    : false;

test("the web's open and close run signed on localnet, through the same encoders and step order a wallet would see", { skip, timeout: 180_000 }, async () => {
  const conn = new Connection(RPC, "confirmed");
  await conn.getVersion(); // a validator answers, or this throws with the RPC in the message
  const programId = localnetProgramId();
  const owner = Keypair.generate();
  const keeper = Keypair.generate().publicKey;
  const events: SolanaStepEvent[] = [];
  const emit: SolanaEmit = (e) => events.push(e);

  // ── fund the throwaway owner: SOL for fees, 10 ZEC to deposit, 100 USDC for the close's top-up ──
  const air = await conn.requestAirdrop(owner.publicKey, 20 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(air, "confirmed");
  const zecAuthority = keyFile(ZEC_AUTHORITY);
  const usdcAuthority = keyFile(USDC_AUTHORITY);
  const ownerZec = getAssociatedTokenAddressSync(PK.zecMint, owner.publicKey);
  const ownerUsdc = getAssociatedTokenAddressSync(PK.usdcMint, owner.publicKey);
  await send(conn, [
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ownerZec, owner.publicKey, PK.zecMint),
    createMintToInstruction(PK.zecMint, ownerZec, zecAuthority.publicKey, 10n * ONE_ZEC),
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ownerUsdc, owner.publicKey, PK.usdcMint),
    createMintToInstruction(PK.usdcMint, ownerUsdc, usdcAuthority.publicKey, 100n * ONE_USDC),
  ], [owner, zecAuthority, usdcAuthority]);

  // ── the oracle: the demo snapshot's ZEC price (spot and TWAP together), stamped with the validator's clock ──
  const view = demoSolanaBorrow();
  const priceValue = BigInt(Math.round(view.zecPriceUsd! * 1e8));
  const R = KAMINO_ZCASH_MARKET.reserves;
  await send(conn, [
    ixSetPrice(owner.publicKey, R.ZEC.scopePriceChain[0]!, priceValue, 8n),
    ixSetPrice(owner.publicKey, R.ZEC.scopeTwapChain[0]!, priceValue, 8n),
    ixStampFresh(owner.publicKey),
  ], [owner]);

  // ── the plan the wizard would build: 10 ZEC at the slider's lowest offered HF — a quarter of a percent above
  //    Kamino's cap, because the cap exactly is refused by klend (BorrowTooLarge; found by this test's first run) ──
  const bounds = solanaHfBounds(view)!;
  assert.equal(bounds.minHf, 1.629);
  const plan = planSolanaOpen({ collateralZec: 10, entryHf: bounds.minHf, view })!;
  assert.ok(plan.borrowUsdc > 0);
  const steps = openSteps(plan, { accountExists: false, keeperConfigured: true });
  assert.deepEqual(steps.map((s) => s.id), ["init", "deposit", "borrow", "grant"]);
  const slot = await conn.getSlot("confirmed");
  const nowS = (await conn.getBlockTime(slot))!;

  // ── open: four signatures, the wizard's function, the throwaway key signing ──
  const wallet = keypairWallet(owner);
  const account = accountPda(programId, owner.publicKey);
  const sigs = await runSolanaOpen({ conn, wallet, programId, account, keeper, plan, accountExists: false, nowS, emit });
  assert.equal(sigs.length, 4);
  assert.deepEqual(events.filter((e) => e.type === "done").map((e) => e.step), [0, 1, 2, 3]);
  assert.equal(events.some((e) => e.type === "failed"), false, JSON.stringify(events.filter((e) => e.type === "failed")));

  // ── read back with the position reader the dashboard uses ──
  const p = await readSolanaPosition(conn, programId, owner.publicKey, keeper);
  assert.equal(p.exists, true);
  assert.ok(p.obligation, "an obligation on Kamino");
  const collateral = Number(p.collateralZecUnits) / Number(ONE_ZEC);
  assert.ok(Math.abs(collateral - 10) < 1e-6, `collateral ${collateral} ZEC`);
  const debt = Number(p.debtUsdcUnits) / Number(ONE_USDC);
  assert.ok(Math.abs(debt - plan.borrowUsdc) < 0.05, `debt ${debt} vs planned ${plan.borrowUsdc}`);
  assert.equal(p.accountUsdc.amount, plan.borrowUnits, "the borrow lands in the account's USDC token account");
  assert.equal(p.walletZec.amount, 0n, "the ZEC left the wallet");
  assert.ok(p.grant, "the grant exists");
  const rem = grantRemaining(p.grant!, p.user!.grantEpoch, BigInt(nowS));
  assert.equal(rem.live, true);
  assert.equal(p.grant!.sellZecPerPeriod, plan.collateralUnits, "decision 1's default: the whole collateral is the sell budget");

  // ── the exit hatch: top up the interest margin from the wallet, close, move both tokens home ──
  await send(conn, [ixStampFresh(owner.publicKey)], [owner]);
  const closing = closeSteps(p);
  assert.deepEqual(closing.map((s) => s.id), ["topup", "close", "transfer_zec", "transfer_usdc"]);
  events.length = 0;
  const closeSigs = await runSolanaClose({ conn, wallet, programId, position: p, emit });
  assert.equal(closeSigs.length, 4);
  assert.equal(events.some((e) => e.type === "failed"), false, JSON.stringify(events.filter((e) => e.type === "failed")));
  const after = await readSolanaPosition(conn, programId, owner.publicKey, keeper);
  assert.equal(after.debtUsdcUnits, 0n);
  assert.equal(after.collateralZecUnits, 0n);
  assert.equal(after.accountZec.amount, 0n);
  assert.equal(after.accountUsdc.amount, 0n);
  assert.equal(after.walletZec.amount, 10n * ONE_ZEC, "every ZEC is back in the wallet");
  const usdcBack = Number(after.walletUsdc.amount) / Number(ONE_USDC);
  assert.ok(usdcBack > 99.8 && usdcBack <= 100, `USDC back in the wallet: ${usdcBack} (the interest of a few seconds and the top-up margin are all it cost)`);
});
