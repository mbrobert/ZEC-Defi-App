// Owner path on localnet (cloned ZCASH-market world; Scope replaced by the mock so prices are stamped fresh before
// every Kamino-touching call): init_account → deposit → borrow refused above the offer → borrow at Kamino's
// 40 % cap (HF 1.625) → withdraw refused below the exit floor → close_position refused when short → repay → withdraw
// all → transfer_out → grant / revoke / revoke_all → a second cycle closed in one instruction.
// Every address comes from @zyo/shared; every threshold from the generated ladder.
//
// Runs under `anchor test --skip-local-validator` with `bash scripts/localnet.sh` up (SETUP.md).
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY, Transaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { KAMINO_ZCASH_MARKET, SOLANA_PROGRAMS, SOLANA_TOKENS, HF_LADDER, ENTRY_HF_FLOOR } from "@zyo/shared";
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
const ONE_ZEC = 100_000_000n; // 8 dp
const ONE_USDC = 1_000_000n; // 6 dp
const U64_MAX = new BN("18446744073709551615");
/** The cloned ZEC reserve's liquidation threshold and LTV cap (VERIFIED-SOLANA-FACTS.md); the program reads both from the reserve. */
const LT = 0.65;
const KAMINO_LTV_CAP = 0.4;
/** Scope entries both reserves read: ZEC price 430, ZEC TWAP 429, USDC price 13, USDC TWAP 456 (facts file). */
const SCOPE_ENTRIES = [R.ZEC.scopePriceChain[0], R.ZEC.scopeTwapChain[0], R.USDC.scopePriceChain[0], R.USDC.scopeTwapChain[0]];

// Obligation offsets (klend-sdk 12.0.0, byte-verified 2026-09-12; the same numbers the program uses).
const OB = { depositedValueSf: 1192, bfAdjustedDebtSf: 2208, unhealthySf: 2256, hasDebt: 2287, owner: 64, deposit0Amount: 96 + 32, borrow0AmountSf: 1208 + 88 };
const SF = 1n << 60n;
const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n);
const keyFile = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

describe("owner path (localnet)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Oilskin as Program<Oilskin>;
  // The Scope mock sits at Scope's own program id (scripts/localnet.sh); its IDL carries that address.
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
  const [obligation] = PublicKey.findProgramAddressSync(
    [Buffer.from([0]), Buffer.from([0]), account.toBuffer(), MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
    KLEND
  );
  const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);
  const ownerZec = getAssociatedTokenAddressSync(ZEC_MINT, owner.publicKey);
  const ownerUsdc = getAssociatedTokenAddressSync(USDC_MINT, owner.publicKey);
  const accountZec = getAssociatedTokenAddressSync(ZEC_MINT, account, true);
  const accountUsdc = getAssociatedTokenAddressSync(USDC_MINT, account, true);

  const kamino = {
    klendProgram: KLEND,
    lendingMarket: MARKET,
    lendingMarketAuthority: lma,
    zecReserve: pk(R.ZEC.address),
    usdcReserve: pk(R.USDC.address),
    zecMint: ZEC_MINT,
    usdcMint: USDC_MINT,
    zecLiquiditySupply: pk(R.ZEC.liquiditySupplyVault),
    zecCollateralMint: pk(R.ZEC.collateralMint),
    zecCollateralSupply: pk(R.ZEC.collateralSupplyVault),
    usdcLiquiditySupply: pk(R.USDC.liquiditySupplyVault),
    usdcFeeVault: pk(R.USDC.liquidityFeeVault),
    scopePrices: SCOPE_PRICES,
    farmsProgram: FARMS,
    instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  const cu = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];

  /** Stamp the four Scope entries with the validator's clock so klend's 180 s / 240 s age checks pass. */
  const stamp = () => mockScope.methods.stampFresh(SCOPE_ENTRIES).accounts({ oraclePrices: SCOPE_PRICES, payer: provider.wallet.publicKey }).rpc();
  /** Move the ZEC price (spot and TWAP together, so the 10 % TWAP divergence check passes) and stamp. */
  const setZecPrice = async (usd: number) => {
    const v = new BN(Math.round(usd * 1e8));
    for (const i of [R.ZEC.scopePriceChain[0], R.ZEC.scopeTwapChain[0]]) {
      await mockScope.methods.setPrice(i, v, new BN(8)).accounts({ oraclePrices: SCOPE_PRICES, payer: provider.wallet.publicKey }).rpc();
    }
    await stamp();
  };
  const mintUsdcToAccount = async (amount: bigint) => {
    const tx = new Transaction().add(createMintToInstruction(USDC_MINT, accountUsdc, usdcAuthority.publicKey, amount));
    await provider.sendAndConfirm(tx, [usdcAuthority]);
  };

  const readObligation = async () => {
    const info = await conn.getAccountInfo(obligation, "processed");
    if (!info) throw new Error("obligation missing");
    const b = info.data;
    const dep = u128(b, OB.depositedValueSf), debt = u128(b, OB.bfAdjustedDebtSf), unhealthy = u128(b, OB.unhealthySf);
    const hf = debt === 0n ? Infinity : Number((unhealthy * 10_000n) / debt) / 10_000;
    const ltv = dep === 0n ? 0 : Number((debt * 10_000n) / dep) / 10_000;
    return { hf, ltv, deposited: b.readBigUInt64LE(OB.deposit0Amount), usdcDebt: u128(b, OB.borrow0AmountSf) / SF, hasDebt: b[OB.hasDebt] === 1, owner: new PublicKey(b.subarray(OB.owner, OB.owner + 32)) };
  };
  const zecPriceUsd = async () => {
    const info = await conn.getAccountInfo(SCOPE_PRICES, "processed");
    const o = 40 + R.ZEC.scopePriceChain[0] * 56;
    return Number(info!.data.readBigUInt64LE(o)) / 10 ** Number(info!.data.readBigUInt64LE(o + 8));
  };
  const expectAnchorError = async (p: Promise<unknown>, code: string) => {
    try {
      await p;
    } catch (e: any) {
      const got = e?.error?.errorCode?.code ?? e?.errorCode?.code ?? String(e);
      expect(got, `expected ${code}, got ${String(e).slice(0, 400)}`).to.equal(code);
      return;
    }
    expect.fail(`expected ${code}, but the call succeeded`);
  };
  const ownerCall = (m: any) => m.preInstructions(cu).signers([owner]).rpc();

  before(async () => {
    releaseWs = keepWebSocketWarm(conn);
    for (const [k, sol] of [[owner, 20], [keeper, 2]] as const) {
      const sig = await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
    }
    // 20 ZEC to the owner from the fixture's local mint authority (mainnet's is the bridge PDA).
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ownerZec, owner.publicKey, ZEC_MINT),
      createMintToInstruction(ZEC_MINT, ownerZec, zecAuthority.publicKey, 20n * ONE_ZEC)
    );
    await provider.sendAndConfirm(tx, [owner, zecAuthority]);
    expect((await getAccount(conn, ownerZec)).amount).to.equal(20n * ONE_ZEC);
    await stamp();
  });

  it("init_account creates the Account PDA, both ATAs, and a Kamino obligation owned by the Account", async () => {
    await ownerCall(
      program.methods.initAccount().accounts({
        owner: owner.publicKey,
        account,
        zecMint: ZEC_MINT,
        usdcMint: USDC_MINT,
        accountZec,
        accountUsdc,
        userMetadata,
        obligation,
        lendingMarket: MARKET,
        klendProgram: KLEND,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      } as any)
    );
    const acct = await program.account.userAccount.fetch(account);
    expect(acct.owner.equals(owner.publicKey)).to.equal(true);
    expect(acct.obligation.equals(obligation)).to.equal(true);
    expect(acct.grantEpoch.toNumber()).to.equal(0);
    const ob = await readObligation();
    expect(ob.owner.equals(account), "obligation owner must be the Account PDA").to.equal(true);
    expect(ob.hasDebt).to.equal(false);
  });

  it("deposit moves 10 ZEC wallet → Account → Kamino collateral", async () => {
    await stamp();
    await ownerCall(program.methods.deposit(new BN((10n * ONE_ZEC).toString())).accounts({ owner: owner.publicKey, account, obligation, userMetadata, rent: SYSVAR_RENT_PUBKEY, systemProgram: SystemProgram.programId, ownerZec, accountZec, kamino, tokenProgram: TOKEN_PROGRAM_ID } as any));
    expect((await getAccount(conn, ownerZec)).amount).to.equal(10n * ONE_ZEC);
    expect((await getAccount(conn, accountZec)).amount).to.equal(0n);
    const ob = await readObligation();
    // cToken exchange rate is 1:1 on this reserve within rounding (nothing is lent out of it).
    expect(Number(ob.deposited)).to.be.closeTo(Number(10n * ONE_ZEC), 1000);
  });

  let topBorrowUsdc = 0n;

  it("borrow above the offer (55 % LTV → HF 1.18) is refused — by Kamino's 40 % cap today, by our 1.25 floor (52 % LTV on LT 65 %) if the venue ever loosened past it", async () => {
    const price = await zecPriceUsd();
    const collateralUsd = 10 * price;
    // The floor in LTV terms is LT ÷ ENTRY_HF_FLOOR (0.52); three points above it HF = 0.65 ÷ 0.55 = 1.18 < 1.25,
    // so BOTH ceilings refuse this borrow. There is no product-wide cap under the venue's since 2026-09-12.
    const floorLtv = LT / ENTRY_HF_FLOOR;
    expect(floorLtv, "Kamino's cap sits under the floor on this market").to.be.greaterThan(KAMINO_LTV_CAP);
    const tooMuch = BigInt(Math.floor(collateralUsd * (floorLtv + 0.03) * 1e6));
    topBorrowUsdc = BigInt(Math.floor(collateralUsd * KAMINO_LTV_CAP * 1e6)) - 5n * ONE_USDC; // a few dollars under the cap
    await stamp();
    let code = "";
    try {
      await ownerCall(program.methods.borrow(new BN(tooMuch.toString())).accounts({ owner: owner.publicKey, account, obligation, accountUsdc, kamino } as any));
    } catch (e: any) {
      code = e?.error?.errorCode?.code ?? String(e);
    }
    // LT 65 / LTV 40 → the venue's cap is the tighter of the two (HF at its cap = 1.625 > 1.25). Our floor is
    // defense in depth here and is exercised by the program's host unit tests (health.rs).
    expect(["BorrowTooLarge", "EntryHfTooLow"], `got ${code}`).to.include(code);
  });

  it("borrow at Kamino's 40 % cap (the top of the slider on this market) lands USDC in the Account at HF ≈ 1.625 ≥ the 1.25 floor", async () => {
    await stamp();
    await ownerCall(program.methods.borrow(new BN(topBorrowUsdc.toString())).accounts({ owner: owner.publicKey, account, obligation, accountUsdc, kamino } as any));
    expect((await getAccount(conn, accountUsdc)).amount).to.equal(topBorrowUsdc);
    const ob = await readObligation();
    expect(ob.hasDebt).to.equal(true);
    expect(ob.hf).to.be.greaterThanOrEqual(ENTRY_HF_FLOOR);
    expect(ob.hf).to.be.lessThan(1.7);
    expect(ob.ltv).to.be.lessThanOrEqual(KAMINO_LTV_CAP);
    expect(ob.hf).to.be.closeTo(LT / KAMINO_LTV_CAP, 0.01);
    expect(HF_LADDER.every((r) => ob.hf > r.hf), "no rung crossed at entry").to.equal(true);
  });

  it("withdraw that would breach the exit floor is refused — by Kamino's LTV cap today (7 ZEC left: LTV 57 %), by our 1.25 floor (HF 1.14) if the venue ever loosened", async () => {
    await stamp();
    let code = "";
    try {
      await ownerCall(program.methods.withdraw(new BN((3n * ONE_ZEC).toString())).accounts({ owner: owner.publicKey, account, obligation, accountZec, kamino } as any));
    } catch (e: any) {
      code = e?.error?.errorCode?.code ?? String(e);
    }
    expect(["WithdrawTooLarge", "ExitHfTooLow"], `got ${code}`).to.include(code);
    expect(Number((await getAccount(conn, accountZec)).amount)).to.equal(0);
  });

  it("close_position refuses up front when the Account's USDC cannot cover the debt", async () => {
    await program.methods
      .transferOut(new BN(ONE_USDC.toString()))
      .accounts({ owner: owner.publicKey, account, mint: USDC_MINT, accountToken: accountUsdc, ownerToken: ownerUsdc, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId } as any)
      .signers([owner])
      .rpc();
    await stamp();
    await expectAnchorError(ownerCall(program.methods.closePosition().accounts({ owner: owner.publicKey, account, obligation, accountZec, accountUsdc, kamino } as any)), "InsufficientUsdcToClose");
  });

  it("repay half, then top up one USDC and repay everything: the debt is gone", async () => {
    const half = topBorrowUsdc / 2n;
    await stamp();
    await ownerCall(program.methods.repay(new BN(half.toString())).accounts({ owner: owner.publicKey, account, obligation, accountUsdc, kamino } as any));
    let ob = await readObligation();
    expect(Number(ob.usdcDebt)).to.be.lessThan(Number(topBorrowUsdc - half) + 100);
    expect(ob.hf).to.be.greaterThan(3.0);
    await mintUsdcToAccount(2n * ONE_USDC); // the dollar moved out above, plus the interest accrued since the borrow
    await stamp();
    await ownerCall(program.methods.repay(U64_MAX).accounts({ owner: owner.publicKey, account, obligation, accountUsdc, kamino } as any));
    ob = await readObligation();
    expect(ob.hasDebt).to.equal(false);
    expect(ob.usdcDebt).to.equal(0n);
    const left = (await getAccount(conn, accountUsdc)).amount;
    expect(Number(left)).to.be.lessThan(Number(2n * ONE_USDC));
    expect(Number(left)).to.be.greaterThan(0);
  });

  it("withdraw everything is allowed once there is no debt; the ZEC is back in the Account", async () => {
    await stamp();
    await ownerCall(program.methods.withdraw(U64_MAX).accounts({ owner: owner.publicKey, account, obligation, accountZec, kamino } as any));
    expect(Number((await getAccount(conn, accountZec)).amount)).to.be.closeTo(Number(10n * ONE_ZEC), 1000);
    expect(await conn.getAccountInfo(obligation), "klend closes an emptied obligation and refunds its rent to the Account").to.equal(null);
  });

  it("transfer_out returns the ZEC (and the USDC change) to the wallet — owner-only, no other gate", async () => {
    const zec = (await getAccount(conn, accountZec)).amount;
    await program.methods
      .transferOut(new BN(zec.toString()))
      .accounts({ owner: owner.publicKey, account, mint: ZEC_MINT, accountToken: accountZec, ownerToken: ownerZec, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId } as any)
      .signers([owner])
      .rpc();
    expect(Number((await getAccount(conn, ownerZec)).amount)).to.be.closeTo(Number(20n * ONE_ZEC), 1000);
    const usdc = (await getAccount(conn, accountUsdc)).amount;
    await program.methods
      .transferOut(new BN(usdc.toString()))
      .accounts({ owner: owner.publicKey, account, mint: USDC_MINT, accountToken: accountUsdc, ownerToken: ownerUsdc, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId } as any)
      .signers([owner])
      .rpc();
    expect((await getAccount(conn, ownerUsdc)).amount).to.equal(usdc + ONE_USDC);
    // A stranger cannot move the owner's tokens: the Account PDA is derived from the OWNER's key.
    const stranger = Keypair.generate();
    const sig = await conn.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    let moved = false;
    try {
      await program.methods
        .transferOut(new BN(1))
        .accounts({ owner: stranger.publicKey, account, mint: ZEC_MINT, accountToken: accountZec, ownerToken: getAssociatedTokenAddressSync(ZEC_MINT, stranger.publicKey), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId } as any)
        .signers([stranger])
        .rpc();
      moved = true;
    } catch (e) {
      /* refused: seeds / has_one */
    }
    expect(moved, "a stranger moved the owner's tokens").to.equal(false);
  });

  it("grant → shape → slippage cap → revoke twice → revoke_all bumps the epoch", async () => {
    const now = Math.floor(Date.now() / 1000);
    const params = { expiryTs: new BN(now + 30 * 86400), periodSecs: new BN(86400), repayUsdcPerPeriod: new BN(2_000_000_000), sellZecPerPeriod: new BN((2n * ONE_ZEC).toString()), maxSellSlippageBps: 300, allowedRungs: 0b1111 };
    const [grantPda] = PublicKey.findProgramAddressSync([Buffer.from("grant"), account.toBuffer(), keeper.publicKey.toBuffer()], program.programId);
    await program.methods.grant(keeper.publicKey, params).accounts({ owner: owner.publicKey, account, grant: grantPda, systemProgram: SystemProgram.programId } as any).signers([owner]).rpc();
    const g = await program.account.grant.fetch(grantPda);
    expect(g.keeper.equals(keeper.publicKey)).to.equal(true);
    expect(g.epoch.toNumber()).to.equal(0);
    expect(g.sellZecPerPeriod.toString()).to.equal((2n * ONE_ZEC).toString());
    expect(g.allowedRungs).to.equal(15);
    await expectAnchorError(
      program.methods.grant(keeper.publicKey, { ...params, maxSellSlippageBps: 501 }).accounts({ owner: owner.publicKey, account, grant: grantPda, systemProgram: SystemProgram.programId } as any).signers([owner]).rpc(),
      "InvalidGrant"
    );
    await program.methods.revoke(keeper.publicKey).accounts({ owner: owner.publicKey, account, grant: grantPda } as any).signers([owner]).rpc();
    expect((await program.account.grant.fetch(grantPda)).expiryTs.toNumber()).to.equal(0);
    await expectAnchorError(program.methods.revoke(keeper.publicKey).accounts({ owner: owner.publicKey, account, grant: grantPda } as any).signers([owner]).rpc(), "NotRevocable");
    await program.methods.revokeAll().accounts({ owner: owner.publicKey, account } as any).signers([owner]).rpc();
    expect((await program.account.userAccount.fetch(account)).grantEpoch.toNumber()).to.equal(1);
  });

  it("second cycle: deposit 5, borrow 1,000, top up 10 USDC, close_position repays and withdraws in one instruction", async () => {
    await stamp();
    // The previous full withdraw made klend close the obligation; deposit re-creates it (same PDA).
    expect((await conn.getAccountInfo(obligation)), "klend closes an emptied obligation").to.equal(null);
    await ownerCall(program.methods.deposit(new BN((5n * ONE_ZEC).toString())).accounts({ owner: owner.publicKey, account, obligation, userMetadata, rent: SYSVAR_RENT_PUBKEY, systemProgram: SystemProgram.programId, ownerZec, accountZec, kamino, tokenProgram: TOKEN_PROGRAM_ID } as any));
    expect((await readObligation()).owner.equals(account)).to.equal(true);
    await stamp();
    await ownerCall(program.methods.borrow(new BN((1000n * ONE_USDC).toString())).accounts({ owner: owner.publicKey, account, obligation, accountUsdc, kamino } as any));
    await mintUsdcToAccount(10n * ONE_USDC);
    await stamp();
    await ownerCall(program.methods.closePosition().accounts({ owner: owner.publicKey, account, obligation, accountZec, accountUsdc, kamino } as any));
    expect(await conn.getAccountInfo(obligation), "closed by klend once emptied").to.equal(null);
    expect(Number((await getAccount(conn, accountZec)).amount)).to.be.closeTo(Number(5n * ONE_ZEC), 1000);
    // The Account held exactly the 1,000 it borrowed plus the 10 topped up; the close repaid 1,000 + interest.
    const usdcLeft = Number((await getAccount(conn, accountUsdc)).amount);
    expect(usdcLeft).to.be.greaterThan(Number(9n * ONE_USDC));
    expect(usdcLeft, "interest may round to zero within a few slots").to.be.at.most(Number(10n * ONE_USDC));
  });
});
