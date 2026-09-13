// The ladder on localnet: a position at the top preset, the ZEC price walked down by the Scope mock, and
// keeper_protect exercised at every rung — refusals by name first, then the repay-only path from idle USDC,
// then the sale path (keeper pays USDC in, the program repays, releases ZEC at the Scope floor, delegates it),
// then revocation. Every threshold from the generated ladder; every address from @zyo/shared.
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY, Transaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { KAMINO_ZCASH_MARKET, SOLANA_PROGRAMS, SOLANA_TOKENS, HF_LADDER, rungById } from "@zyo/shared";
import type { Oilskin } from "../target/types/oilskin";
import { keepWebSocketWarm } from "./support/wsKeepalive";

const pk = (s: string) => new PublicKey(s);
const KLEND = pk(SOLANA_PROGRAMS.klend);
const FARMS = pk(SOLANA_PROGRAMS.farms);
const MARKET = pk(KAMINO_ZCASH_MARKET.lendingMarket);
const SCOPE_PRICES = pk(KAMINO_ZCASH_MARKET.scopeOraclePrices);
const R = KAMINO_ZCASH_MARKET.reserves;
const ZEC_MINT = pk(SOLANA_TOKENS.ZEC.mint);
const USDC_MINT = pk(SOLANA_TOKENS.USDC.mint);
const ONE_ZEC = 100_000_000n;
const ONE_USDC = 1_000_000n;
const SCOPE_ENTRIES = [R.ZEC.scopePriceChain[0], R.ZEC.scopeTwapChain[0], R.USDC.scopePriceChain[0], R.USDC.scopeTwapChain[0]];
const OB = { depositedValueSf: 1192, bfAdjustedDebtSf: 2208, unhealthySf: 2256, hasDebt: 2287, deposit0Amount: 96 + 32, borrow0AmountSf: 1208 + 88 };
const SF = 1n << 60n;
const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n);
const keyFile = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const RUNG = { warn: 0, repay: 1, derisk: 2, emergency: 3 } as const;

describe("ladder (localnet, Scope mock walks the ZEC price)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Oilskin as Program<Oilskin>;
  const mockScope = new Program(require("../target/idl/mock_scope.json"), provider);
  const conn = provider.connection;
  let releaseWs: () => Promise<void> = async () => {};
  after(async () => releaseWs());

  const owner = Keypair.generate();
  const keeper = Keypair.generate();
  const zecAuthority = keyFile("fixtures/local-mint-authority.json");
  const usdcAuthority = keyFile("fixtures/local-usdc-mint-authority.json");

  const [account] = PublicKey.findProgramAddressSync([Buffer.from("account"), owner.publicKey.toBuffer()], program.programId);
  const [userMetadata] = PublicKey.findProgramAddressSync([Buffer.from("user_meta"), account.toBuffer()], KLEND);
  const [obligation] = PublicKey.findProgramAddressSync([Buffer.from([0]), Buffer.from([0]), account.toBuffer(), MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()], KLEND);
  const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);
  const [grantPda] = PublicKey.findProgramAddressSync([Buffer.from("grant"), account.toBuffer(), keeper.publicKey.toBuffer()], program.programId);
  const ownerZec = getAssociatedTokenAddressSync(ZEC_MINT, owner.publicKey);
  const keeperZec = getAssociatedTokenAddressSync(ZEC_MINT, keeper.publicKey);
  const keeperUsdc = getAssociatedTokenAddressSync(USDC_MINT, keeper.publicKey);
  const accountZec = getAssociatedTokenAddressSync(ZEC_MINT, account, true);
  const accountUsdc = getAssociatedTokenAddressSync(USDC_MINT, account, true);

  const kamino = {
    klendProgram: KLEND, lendingMarket: MARKET, lendingMarketAuthority: lma,
    zecReserve: pk(R.ZEC.address), usdcReserve: pk(R.USDC.address), zecMint: ZEC_MINT, usdcMint: USDC_MINT,
    zecLiquiditySupply: pk(R.ZEC.liquiditySupplyVault), zecCollateralMint: pk(R.ZEC.collateralMint), zecCollateralSupply: pk(R.ZEC.collateralSupplyVault),
    usdcLiquiditySupply: pk(R.USDC.liquiditySupplyVault), usdcFeeVault: pk(R.USDC.liquidityFeeVault),
    scopePrices: SCOPE_PRICES, farmsProgram: FARMS, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID,
  };
  const cu = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];
  const stamp = () => mockScope.methods.stampFresh(SCOPE_ENTRIES).accounts({ oraclePrices: SCOPE_PRICES, payer: provider.wallet.publicKey }).rpc();
  const setZecPrice = async (usd: number) => {
    const v = new BN(Math.round(usd * 1e8));
    for (const i of [R.ZEC.scopePriceChain[0], R.ZEC.scopeTwapChain[0]]) {
      await mockScope.methods.setPrice(i, v, new BN(8)).accounts({ oraclePrices: SCOPE_PRICES, payer: provider.wallet.publicKey }).rpc();
    }
    await stamp();
  };
  const readObligation = async () => {
    const info = await conn.getAccountInfo(obligation, "processed");
    if (!info) return { hf: Infinity, ltv: 0, deposited: 0n, usdcDebt: 0n, hasDebt: false };
    const b = info.data;
    const dep = u128(b, OB.depositedValueSf), debt = u128(b, OB.bfAdjustedDebtSf), unhealthy = u128(b, OB.unhealthySf);
    return {
      hf: debt === 0n ? Infinity : Number((unhealthy * 10_000n) / debt) / 10_000,
      ltv: dep === 0n ? 0 : Number((debt * 10_000n) / dep) / 10_000,
      deposited: b.readBigUInt64LE(OB.deposit0Amount),
      usdcDebt: u128(b, OB.borrow0AmountSf) / SF,
      hasDebt: b[OB.hasDebt] === 1,
    };
  };
  /** Off-chain HF at a hypothetical price, from the current obligation (same math as the program). */
  const hfAt = async (priceUsd: number) => {
    const ob = await readObligation();
    const collateralUsd = (Number(ob.deposited) / 1e8) * priceUsd;
    return (collateralUsd * 0.65) / (Number(ob.usdcDebt) / 1e6);
  };
  const errCode = async (p: Promise<unknown>) => {
    try {
      await p;
      return "OK";
    } catch (e: any) {
      return e?.error?.errorCode?.code ?? String(e).slice(0, 200);
    }
  };
  const protect = (rung: number, repayUsdc: bigint, sellZec: bigint, pre: any[] = []) =>
    program.methods
      .keeperProtect(rung, new BN(repayUsdc.toString()), new BN(sellZec.toString()))
      .accounts({ keeper: keeper.publicKey, account, grant: grantPda, obligation, accountZec, accountUsdc, kamino, tokenProgram: TOKEN_PROGRAM_ID } as any)
      .preInstructions([...cu, ...pre])
      .signers([keeper])
      .rpc();

  let entryPrice = 0;
  let borrowed = 0n;

  before(async () => {
    releaseWs = keepWebSocketWarm(conn);
    for (const [k, sol] of [[owner, 20], [keeper, 20]] as const) {
      const sig = await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
    }
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ownerZec, owner.publicKey, ZEC_MINT),
      createMintToInstruction(ZEC_MINT, ownerZec, zecAuthority.publicKey, 10n * ONE_ZEC),
      createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, keeperUsdc, keeper.publicKey, USDC_MINT),
      createMintToInstruction(USDC_MINT, keeperUsdc, usdcAuthority.publicKey, 10_000n * ONE_USDC),
      createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, keeperZec, keeper.publicKey, ZEC_MINT)
    );
    await provider.sendAndConfirm(tx, [owner, keeper, zecAuthority, usdcAuthority]);
    // A known price for the whole walk: $1,000 spot and TWAP (inside the reserve's $400–$2,000 band).
    entryPrice = 1000;
    await setZecPrice(entryPrice);
    await program.methods.initAccount().accounts({ owner: owner.publicKey, account, zecMint: ZEC_MINT, usdcMint: USDC_MINT, accountZec, accountUsdc, userMetadata, obligation, lendingMarket: MARKET, klendProgram: KLEND, rent: SYSVAR_RENT_PUBKEY, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID } as any).preInstructions(cu).signers([owner]).rpc();
    await stamp();
    await program.methods.deposit(new BN((10n * ONE_ZEC).toString())).accounts({ owner: owner.publicKey, account, obligation, userMetadata, rent: SYSVAR_RENT_PUBKEY, systemProgram: SystemProgram.programId, ownerZec, accountZec, kamino, tokenProgram: TOKEN_PROGRAM_ID } as any).preInstructions(cu).signers([owner]).rpc();
    // Borrow at the top preset: 40 % of $10,000 → HF 1.625.
    borrowed = 3_990n * ONE_USDC;
    await stamp();
    await program.methods.borrow(new BN(borrowed.toString())).accounts({ owner: owner.publicKey, account, obligation, accountUsdc, kamino } as any).preInstructions(cu).signers([owner]).rpc();
    expect((await readObligation()).hf).to.be.closeTo(1.629, 0.01);
    // Grant: repay 5,000 USDC / day, sell 5 ZEC / day, 2 % slippage allowance, every rung named.
    const now = Math.floor(Date.now() / 1000);
    await program.methods
      .grant(keeper.publicKey, { expiryTs: new BN(now + 86400 * 7), periodSecs: new BN(86400), repayUsdcPerPeriod: new BN((5_000n * ONE_USDC).toString()), sellZecPerPeriod: new BN((5n * ONE_ZEC).toString()), maxSellSlippageBps: 200, allowedRungs: 0b1111 })
      .accounts({ owner: owner.publicKey, account, grant: grantPda, systemProgram: SystemProgram.programId } as any)
      .signers([owner])
      .rpc();
  });

  it("refusals by name while the account is healthy: warn is notify-only, repay is not crossed", async () => {
    await stamp();
    expect(await errCode(protect(RUNG.warn, 100n * ONE_USDC, 0n))).to.equal("RungIsNotifyOnly");
    await stamp();
    expect(await errCode(protect(RUNG.repay, 100n * ONE_USDC, 0n))).to.equal("RungNotCrossed");
  });

  it("a stranger holding no grant cannot act", async () => {
    const stranger = Keypair.generate();
    const sig = await conn.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    const [strangerGrant] = PublicKey.findProgramAddressSync([Buffer.from("grant"), account.toBuffer(), stranger.publicKey.toBuffer()], program.programId);
    const code = await errCode(
      program.methods.keeperProtect(RUNG.repay, new BN(1), new BN(0)).accounts({ keeper: stranger.publicKey, account, grant: strangerGrant, obligation, accountZec, accountUsdc, kamino, tokenProgram: TOKEN_PROGRAM_ID } as any).preInstructions(cu).signers([stranger]).rpc()
    );
    expect(code).to.not.equal("OK");
  });

  it("price −20 % → HF 1.30 crosses repay: naming derisk is refused (not crossed); repay from the Account's idle USDC lifts HF to the disarm level", async () => {
    await setZecPrice(entryPrice * 0.8);
    // The obligation's cached values only move on refresh; the program refreshes inside keeper_protect. Off-chain:
    const hf = await hfAt(entryPrice * 0.8);
    expect(hf).to.be.closeTo(1.30, 0.01);
    expect(rungById("repay").hf).to.be.greaterThan(hf);
    expect(await errCode(protect(RUNG.derisk, 100n * ONE_USDC, 0n))).to.equal("RungNotCrossed");
    // Too small an action must fail as ineffective: 10 USDC lifts nothing.
    await stamp();
    expect(await errCode(protect(RUNG.repay, 10n * ONE_USDC, 0n))).to.equal("ProtectionIneffective");
    // 400 USDC of the Account's idle USDC (it still holds what it borrowed) lifts HF to ≥ 1.40.
    await stamp();
    await protect(RUNG.repay, 400n * ONE_USDC, 0n);
    const after = await readObligation();
    expect(after.hf).to.be.greaterThanOrEqual(rungById("repay").disarmHf);
    const g = await program.account.grant.fetch(grantPda);
    expect(g.repayUsdcSpent.toString()).to.equal((400n * ONE_USDC).toString());
  });

  it("price −34 % → HF 1.17 crosses de-risk: naming repay is refused as understated; a sale below the Scope floor is refused; the keeper pays USDC in, the program repays, releases ZEC and delegates exactly that", async () => {
    await setZecPrice(entryPrice * 0.66);
    const hf = await hfAt(entryPrice * 0.66);
    expect(hf).to.be.lessThan(rungById("derisk").hf);
    expect(hf).to.be.greaterThan(rungById("emergency").hf);
    expect(await errCode(protect(RUNG.repay, 100n * ONE_USDC, 0n))).to.equal("RungUnderstated");

    // The keeper's USDC comes in with the same transaction. 700 USDC for 1 ZEC at $660 × 0.98 = 646.8 floor → OK;
    // 600 USDC for 1 ZEC → below the floor.
    const payIn = (usdc: bigint) => [createTransferInstruction(keeperUsdc, accountUsdc, keeper.publicKey, usdc)];
    // Kamino also refuses to release collateral while LTV stays above 40 %, so the repayment must be large
    // enough for the withdraw to be allowed at all: after repaying 1,500, debt ≈ 2,090 against 9 × $660 = $5,940 (35 %).
    await stamp();
    expect(await errCode(protect(RUNG.derisk, 600n * ONE_USDC, 1n * ONE_ZEC, payIn(600n * ONE_USDC)))).to.not.equal("OK");
    await stamp();
    const zecBefore = (await getAccount(conn, accountZec)).amount;
    await protect(RUNG.derisk, 1_500n * ONE_USDC, 1n * ONE_ZEC, payIn(1_500n * ONE_USDC));
    const after = await readObligation();
    expect(after.hf).to.be.greaterThanOrEqual(rungById("derisk").disarmHf);
    const acct = await getAccount(conn, accountZec);
    expect(Number(acct.amount - zecBefore)).to.be.closeTo(Number(ONE_ZEC), 1000);
    expect(acct.delegate?.equals(keeper.publicKey), "the keeper is the delegate").to.equal(true);
    expect(Number(acct.delegatedAmount)).to.be.closeTo(Number(ONE_ZEC), 1000);
    const g = await program.account.grant.fetch(grantPda);
    expect(g.sellZecSpent.toString()).to.equal((1n * ONE_ZEC).toString());
    expect(g.repayUsdcSpent.toString()).to.equal((1_900n * ONE_USDC).toString());
    // The keeper pulls what it earned — and not one unit more.
    const pull = new Transaction().add(createTransferInstruction(accountZec, keeperZec, keeper.publicKey, acct.delegatedAmount));
    await provider.sendAndConfirm(pull, [keeper]);
    expect((await getAccount(conn, keeperZec)).amount).to.equal(acct.delegatedAmount);
    const extra = new Transaction().add(createTransferInstruction(accountZec, keeperZec, keeper.publicKey, 1n));
    let pulledMore = false;
    try { await provider.sendAndConfirm(extra, [keeper]); pulledMore = true; } catch {}
    expect(pulledMore).to.equal(false);
  });

  it("budgets bind: a repay above what is left in the period is refused", async () => {
    await stamp();
    expect(await errCode(protect(RUNG.derisk, 4_000n * ONE_USDC, 0n))).to.equal("RepayBudgetExceeded");
  });

  it("after revoke_all the keeper is refused by name", async () => {
    await program.methods.revokeAll().accounts({ owner: owner.publicKey, account } as any).signers([owner]).rpc();
    await setZecPrice(entryPrice * 0.5);
    await stamp();
    expect(await errCode(protect(RUNG.emergency, 100n * ONE_USDC, 0n))).to.equal("GrantNotLive");
  });
});
