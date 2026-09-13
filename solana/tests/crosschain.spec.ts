// The cross-chain loop's Solana side on localnet (BUILD-PLAN D6 / B3; SOLANA-ARCHITECTURE §14): the entry HF the
// borrow records and the ladder it derives; `set_base_account`; `deposit_for_burn` through the CLONED Circle CCTP V2
// programs — refused without a Base account, refused when it would leave less than the reserve the debt requires,
// and otherwise a real burn (the USDC supply falls) whose message Circle would attest is read back out of the
// event account: domain 5 → 6, the recorded Base account as mint recipient, the amount, the Account as sender.
// Nothing is attested here (there is no Circle on localnet); the Base leg runs the same bytes through the Foundry
// double (contracts/test/StrategyRouterCrossChain.t.sol). Every address from @zyo/shared; every threshold derived.
//
// Runs under `anchor test --skip-local-validator` with `bash scripts/localnet.sh` up (the CCTP clones landed 2026-09-13).
//
// The burn's account list — Kamino's context for the refresh (16) plus Circle's (11) plus the Account's own — is
// too long for a legacy transaction (1,422 > 1,232 bytes measured here), so the instruction rides a v0
// transaction with an address lookup table (ALT) holding the static accounts, exactly as every klend client
// does; on mainnet the web uses Kamino's market ALT (`4X1u…xu2`, Addendum 1) plus an Oilskin ALT for the CCTP
// PDAs, created once at deploy. Here the spec creates its own.
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { AddressLookupTableProgram, ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY, Transaction, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAccount, getMint, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import {
  CCTP_DOMAINS,
  CCTP_V2_SOLANA,
  KAMINO_ZCASH_MARKET,
  SOLANA_PROGRAMS,
  SOLANA_TOKENS,
  bytes32ToEvmAddress,
  decodeCctpBurnMessageV2,
  evmAddressToBytes32,
  ladderBpsFor,
  reserveUnitsFor,
  rungById,
} from "@zyo/shared";
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
const TMM = pk(CCTP_V2_SOLANA.programs.tokenMessengerMinterV2);
const MT = pk(CCTP_V2_SOLANA.programs.messageTransmitterV2);
const ONE_ZEC = 100_000_000n;
const ONE_USDC = 1_000_000n;
const LT = 0.65;
const KAMINO_LTV_CAP = 0.4;
const SCOPE_ENTRIES = [R.ZEC.scopePriceChain[0], R.ZEC.scopeTwapChain[0], R.USDC.scopePriceChain[0], R.USDC.scopeTwapChain[0]];
const OB = { borrow0AmountSf: 1208 + 88 };
const SF = 1n << 60n;
const keyFile = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const FIXTURES = process.env.OILSKIN_FIXTURES ?? "fixtures";
/** The user's Base OilskinAccount — any 20-byte address here; the Foundry suite plays the other side. */
const BASE_ACCOUNT = "0x1646587E543bC2f63137bAa86F8598E1274aED78";

describe("cross-chain (localnet): the entry record, the Base link, deposit_for_burn with the reserve", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Oilskin as Program<Oilskin>;
  const mockScope = new Program(require("../target/idl/mock_scope.json"), provider);
  const conn = provider.connection;
  let releaseWs: () => Promise<void> = async () => {};
  after(async () => releaseWs());

  const owner = Keypair.generate();
  const stranger = Keypair.generate();
  const zecAuthority = keyFile(`${FIXTURES}/local-mint-authority.json`);

  const [account] = PublicKey.findProgramAddressSync([Buffer.from("account"), owner.publicKey.toBuffer()], program.programId);
  const [userMetadata] = PublicKey.findProgramAddressSync([Buffer.from("user_meta"), account.toBuffer()], KLEND);
  const [obligation] = PublicKey.findProgramAddressSync([Buffer.from([0]), Buffer.from([0]), account.toBuffer(), MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()], KLEND);
  const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);
  const ownerZec = getAssociatedTokenAddressSync(ZEC_MINT, owner.publicKey);
  const accountZec = getAssociatedTokenAddressSync(ZEC_MINT, account, true);
  const accountUsdc = getAssociatedTokenAddressSync(USDC_MINT, account, true);
  // Circle's PDAs that depend on the Account or on Anchor's convention; the rest come from shared by address.
  const [denylist] = PublicKey.findProgramAddressSync([Buffer.from(CCTP_V2_SOLANA.seeds.denylistAccount), account.toBuffer()], TMM);
  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from(CCTP_V2_SOLANA.seeds.eventAuthority)], TMM);

  const kamino = {
    klendProgram: KLEND, lendingMarket: MARKET, lendingMarketAuthority: lma,
    zecReserve: pk(R.ZEC.address), usdcReserve: pk(R.USDC.address), zecMint: ZEC_MINT, usdcMint: USDC_MINT,
    zecLiquiditySupply: pk(R.ZEC.liquiditySupplyVault), zecCollateralMint: pk(R.ZEC.collateralMint), zecCollateralSupply: pk(R.ZEC.collateralSupplyVault),
    usdcLiquiditySupply: pk(R.USDC.liquiditySupplyVault), usdcFeeVault: pk(R.USDC.liquidityFeeVault),
    scopePrices: SCOPE_PRICES, farmsProgram: FARMS, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID,
  };
  const cctp = {
    tokenMessengerMinterProgram: TMM,
    messageTransmitterProgram: MT,
    senderAuthorityPda: pk(CCTP_V2_SOLANA.pdas.senderAuthority),
    denylistAccount: denylist,
    messageTransmitter: pk(CCTP_V2_SOLANA.pdas.messageTransmitter),
    tokenMessenger: pk(CCTP_V2_SOLANA.pdas.tokenMessenger),
    remoteTokenMessenger: pk(CCTP_V2_SOLANA.pdas.remoteTokenMessengerBase),
    tokenMinter: pk(CCTP_V2_SOLANA.pdas.tokenMinter),
    localToken: pk(CCTP_V2_SOLANA.pdas.localTokenUsdc),
    usdcMint: USDC_MINT,
    eventAuthority,
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
  /** Anchor's error name from an `.rpc()` error, or from the preflight logs of a raw v0 send. */
  const errCode = async (p: Promise<unknown>) => {
    try {
      await p;
      return "OK";
    } catch (e: any) {
      if (e?.error?.errorCode?.code) return e.error.errorCode.code as string;
      const logs = e?.logs ?? e?.transactionLogs ?? [];
      const text = String(e) + "\n" + (Array.isArray(logs) ? logs.join("\n") : String(logs));
      return text.match(/Error Code: (\w+)/)?.[1] ?? text.slice(0, 300);
    }
  };
  /** The static accounts of a burn, in one lookup table (the list every klend client ships for the market). */
  let alt: AddressLookupTableAccount;
  const createAlt = async () => {
    const slot = await conn.getSlot("finalized");
    const [createIx, address] = AddressLookupTableProgram.createLookupTable({ authority: owner.publicKey, payer: owner.publicKey, recentSlot: slot });
    const addresses = [...new Map([...Object.values(kamino), ...Object.values(cctp), SystemProgram.programId, obligation, accountUsdc, account].map((k) => [k.toBase58(), k])).values()];
    // create, then extend in chunks: one legacy transaction cannot carry thirty addresses either.
    await provider.sendAndConfirm(new Transaction().add(createIx), [owner]);
    for (let i = 0; i < addresses.length; i += 12) {
      const extendIx = AddressLookupTableProgram.extendLookupTable({ lookupTable: address, authority: owner.publicKey, payer: owner.publicKey, addresses: addresses.slice(i, i + 12) });
      await provider.sendAndConfirm(new Transaction().add(extendIx), [owner]);
    }
    // A table is usable from the slot after the extension lands: poll until the RPC serves it with every address.
    for (let i = 0; i < 40; i++) {
      const res = await conn.getAddressLookupTable(address, { commitment: "confirmed" });
      if (res.value && res.value.state.addresses.length === addresses.length) {
        alt = res.value;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(alt, "the lookup table came back with every address").to.not.equal(undefined);
    await new Promise((r) => setTimeout(r, 1500));
  };
  const usdcDebt = async () => {
    const info = await conn.getAccountInfo(obligation, "processed");
    return info ? (info.data.readBigUInt64LE(OB.borrow0AmountSf) + (info.data.readBigUInt64LE(OB.borrow0AmountSf + 8) << 64n)) / SF : 0n;
  };
  const balance = async (ata: PublicKey) => (await getAccount(conn, ata, "confirmed")).amount;
  const burn = async (amount: bigint, maxFee: bigint, threshold: number, signer: Keypair = owner) => {
    const eventData = Keypair.generate();
    const ix = await program.methods
      .depositForBurn(new BN(amount.toString()), new BN(maxFee.toString()), threshold)
      .accounts({ owner: signer.publicKey, account, obligation, accountUsdc, kamino, cctp, messageSentEventData: eventData.publicKey, systemProgram: SystemProgram.programId } as any)
      .instruction();
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: blockhash, instructions: [...cu, ix] }).compileToV0Message([alt]);
    const tx = new VersionedTransaction(msg);
    tx.sign([signer, eventData]);
    const send = (async () => {
      const sig = await conn.sendTransaction(tx, { skipPreflight: false });
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      return sig;
    })();
    return { eventData, send };
  };

  let entryHfBps = 0;
  let debt = 0n;

  before(async () => {
    releaseWs = keepWebSocketWarm(conn);
    for (const k of [owner, stranger]) {
      const sig = await conn.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
    }
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ownerZec, owner.publicKey, ZEC_MINT),
      createMintToInstruction(ZEC_MINT, ownerZec, zecAuthority.publicKey, 10n * ONE_ZEC)
    );
    await provider.sendAndConfirm(tx, [owner, zecAuthority]);
    await setZecPrice(1000);
    await program.methods.initAccount().accounts({ owner: owner.publicKey, account, zecMint: ZEC_MINT, usdcMint: USDC_MINT, accountZec, accountUsdc, userMetadata, obligation, lendingMarket: MARKET, klendProgram: KLEND, rent: SYSVAR_RENT_PUBKEY, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID } as any).preInstructions(cu).signers([owner]).rpc();
    await stamp();
    await program.methods.deposit(new BN((10n * ONE_ZEC).toString())).accounts({ owner: owner.publicKey, account, obligation, userMetadata, rent: SYSVAR_RENT_PUBKEY, systemProgram: SystemProgram.programId, ownerZec, accountZec, kamino, tokenProgram: TOKEN_PROGRAM_ID } as any).preInstructions(cu).signers([owner]).rpc();
    await stamp();
    // Kamino's 40 % cap: 40 % of $10,000 → HF 1.625; 3,990 USDC lands idle in the Account
    await program.methods.borrow(new BN((3_990n * ONE_USDC).toString())).accounts({ owner: owner.publicKey, account, obligation, accountUsdc, kamino } as any).preInstructions(cu).signers([owner]).rpc();
    debt = await usdcDebt();
    await createAlt();
  });

  it("the world: both CCTP V2 programs are cloned and executable, the five state accounts are theirs, the remote messenger for domain 6 names Base's", async () => {
    for (const p of [TMM, MT]) {
      const a = await conn.getAccountInfo(p);
      expect(a?.executable, p.toBase58()).to.equal(true);
    }
    for (const [name, key] of Object.entries(CCTP_V2_SOLANA.pdas)) {
      if (name === "senderAuthority") continue;
      const a = await conn.getAccountInfo(pk(key));
      expect(a, name).to.not.equal(null);
      expect(a!.owner.equals(name === "messageTransmitter" ? MT : TMM), `${name} owner`).to.equal(true);
    }
    const rtm = (await conn.getAccountInfo(pk(CCTP_V2_SOLANA.pdas.remoteTokenMessengerBase)))!.data;
    expect(rtm.readUInt32LE(8)).to.equal(CCTP_DOMAINS.base);
    expect(bytes32ToEvmAddress(Uint8Array.from(rtm.subarray(12, 44))).toLowerCase()).to.equal("0x28b5a0e9c621a5badaa536219b3a228c8168cf5d");
  });

  it("the borrow recorded the entry HF (≈ 1.625) and the ladder it derives is shared's — 1.57 / 1.40 / 1.23 / 1.06", async () => {
    const acct = await program.account.userAccount.fetch(account);
    entryHfBps = Number(acct.entryHfBps);
    expect(entryHfBps / 10_000).to.be.closeTo(LT / KAMINO_LTV_CAP, 0.01);
    expect(Buffer.from(acct.baseAccount as number[]).equals(Buffer.alloc(32)), "not linked yet").to.equal(true);
    const l = ladderBpsFor(entryHfBps);
    expect(l.map((r) => r.hfBps)).to.deep.equal([15_700, 14_000, 12_300, 10_600]);
    expect(l[1].disarmHfBps).to.equal(14_600);
    expect(l[1].hfBps).to.be.greaterThan(Math.round(rungById("repay").hf * 10_000), "above the floor's repay rung");
  });

  it("deposit_for_burn refuses without a Base account, by name", async () => {
    await stamp();
    expect(await errCode((await burn(100n * ONE_USDC, 1n * ONE_USDC, 1000)).send)).to.equal("NoBaseAccount");
  });

  it("set_base_account: zero and a non-EVM value are refused; the owner records a left-padded address; a stranger cannot", async () => {
    expect(await errCode(program.methods.setBaseAccount(Array.from(new Uint8Array(32))).accounts({ owner: owner.publicKey, account } as any).signers([owner]).rpc())).to.equal("InvalidBaseAccount");
    expect(await errCode(program.methods.setBaseAccount(Array.from(new Uint8Array(32).fill(1))).accounts({ owner: owner.publicKey, account } as any).signers([owner]).rpc())).to.equal("InvalidBaseAccount");
    const b32 = Array.from(evmAddressToBytes32(BASE_ACCOUNT));
    expect(await errCode(program.methods.setBaseAccount(b32).accounts({ owner: stranger.publicKey, account } as any).signers([stranger]).rpc())).to.not.equal("OK");
    await program.methods.setBaseAccount(b32).accounts({ owner: owner.publicKey, account } as any).signers([owner]).rpc();
    const acct = await program.account.userAccount.fetch(account);
    expect(bytes32ToEvmAddress(Uint8Array.from(acct.baseAccount as number[])).toLowerCase()).to.equal(BASE_ACCOUNT.toLowerCase());
  });

  it("deposit_for_burn refuses a burn that would leave the Account under the reserve the debt requires (ReserveShort), and one it cannot fund", async () => {
    const reserve = reserveUnitsFor(debt, entryHfBps);
    expect(Number(reserve) / 1e6).to.be.closeTo((Number(debt) / 1e6) * (600 / 14_600), 0.01, "4.11 % of the debt at entry 1.625");
    const held = await balance(accountUsdc);
    expect(held).to.equal(3_990n * ONE_USDC);
    await stamp();
    expect(await errCode((await burn(held - reserve + 1n, 1n * ONE_USDC, 1000)).send)).to.equal("ReserveShort");
    await stamp();
    expect(await errCode((await burn(held + 1n, 1n * ONE_USDC, 1000)).send)).to.equal("InsufficientUsdcToClose");
    await stamp();
    expect(await errCode((await burn(0n, 0n, 1000)).send)).to.equal("ZeroAmount");
    expect(await balance(accountUsdc)).to.equal(held, "nothing left the Account");
  });

  it("a stranger cannot burn from the Account", async () => {
    await stamp();
    expect(await errCode((await burn(100n * ONE_USDC, 1n * ONE_USDC, 1000, stranger)).send)).to.not.equal("OK");
  });

  it("burns within the reserve through the cloned CCTP programs: the USDC supply falls by the amount, the Account keeps at least the reserve, and the event account carries the V2 message — domain 5 → 6, the Base account as mint recipient, the amount, the Account as sender", async () => {
    const reserve = reserveUnitsFor(debt, entryHfBps);
    const held = await balance(accountUsdc);
    const amount = held - reserve - 10n * ONE_USDC;
    const supplyBefore = (await getMint(conn, USDC_MINT, "confirmed")).supply;
    const maxFee = amount / 10_000n; // 1 bp, the Fast minimum Solana → Base recorded 2026-09-12 (Addendum 1)
    await stamp();
    const { eventData, send } = await burn(amount, maxFee, 1000);
    await send;
    expect(await balance(accountUsdc)).to.equal(held - amount);
    expect((await balance(accountUsdc)) >= reserve, "the reserve stayed").to.equal(true);
    expect((await getMint(conn, USDC_MINT, "confirmed")).supply).to.equal(supplyBefore - amount, "a real burn, not a transfer");
    // Circle's MessageSent account: 8-byte discriminator, rent_payer (32), created_at (8), then the message as a Vec<u8>.
    const info = await conn.getAccountInfo(eventData.publicKey, "confirmed");
    expect(info, "the event account exists").to.not.equal(null);
    expect(info!.owner.equals(MT), "owned by the transmitter program").to.equal(true);
    const d = info!.data;
    const rentPayer = new PublicKey(d.subarray(8, 40));
    expect(rentPayer.equals(owner.publicKey), "the owner paid the rent").to.equal(true);
    const len = d.readUInt32LE(48);
    const message = Uint8Array.from(d.subarray(52, 52 + len));
    const m = decodeCctpBurnMessageV2(message);
    expect(m.sourceDomain).to.equal(CCTP_DOMAINS.solana);
    expect(m.destinationDomain).to.equal(CCTP_DOMAINS.base);
    expect(bytes32ToEvmAddress(m.recipient).toLowerCase()).to.equal("0x28b5a0e9c621a5badaa536219b3a228c8168cf5d", "delivered to Base's TokenMessengerV2");
    expect(Buffer.from(m.destinationCaller).equals(Buffer.alloc(32)), "anyone may deliver").to.equal(true);
    expect(m.minFinalityThreshold).to.equal(1000);
    expect(bytes32ToEvmAddress(m.body.mintRecipient).toLowerCase()).to.equal(BASE_ACCOUNT.toLowerCase(), "the recorded Base account, nothing else");
    expect(m.body.amount).to.equal(amount);
    expect(m.body.maxFee).to.equal(maxFee);
    expect(new PublicKey(m.body.burnToken).equals(USDC_MINT)).to.equal(true);
    expect(new PublicKey(m.body.messageSender).equals(account), "the Account PDA is the sender").to.equal(true);
  });

  it("keeper_protect judges the derived ladder: at HF ≈ 1.20 the crossed rung is de-risk (1.23), so naming repay is understated — on the floor's ladder 1.20 would not even reach repay", async () => {
    // A throwaway keeper with every rung allowed; the price walked to HF 1.20 (a 26 % fall from $1,000).
    const keeper = Keypair.generate();
    const sig = await conn.requestAirdrop(keeper.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    const [grantPda] = PublicKey.findProgramAddressSync([Buffer.from("grant"), account.toBuffer(), keeper.publicKey.toBuffer()], program.programId);
    const chainNow = (await conn.getBlockTime(await conn.getSlot("confirmed")))!;
    await program.methods
      .grant(keeper.publicKey, { expiryTs: new BN(chainNow + 86400), periodSecs: new BN(86400), repayUsdcPerPeriod: new BN((5_000n * ONE_USDC).toString()), sellZecPerPeriod: new BN(0), maxSellSlippageBps: 200, allowedRungs: 0b1111 })
      .accounts({ owner: owner.publicKey, account, grant: grantPda, systemProgram: SystemProgram.programId } as any)
      .signers([owner])
      .rpc();
    const price = (1.2 * (Number(debt) / 1e6)) / (10 * LT);
    await setZecPrice(price);
    const protect = (rung: number) =>
      program.methods.keeperProtect(rung, new BN((100n * ONE_USDC).toString()), new BN(0)).accounts({ keeper: keeper.publicKey, account, grant: grantPda, obligation, accountZec, accountUsdc, kamino, tokenProgram: TOKEN_PROGRAM_ID } as any).preInstructions(cu).signers([keeper]).rpc();
    expect(await errCode(protect(1))).to.equal("RungUnderstated");
    await stamp();
    expect(await errCode(protect(3))).to.equal("RungNotCrossed");
  });
});
