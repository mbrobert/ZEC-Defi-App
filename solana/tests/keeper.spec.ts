// The keeper AGENT on localnet — the real reader, dispatcher and monitor from @zyo/agent, driven by runSolanaKeeper
// against the cloned ZCASH market: a position opened through the program, a grant to a throwaway keeper key, the ZEC
// price walked down by the Scope mock. What ladder.spec.ts proves about the PROGRAM this proves about the KEEPER:
// discovery by program-account scan, valuation from one simulated refresh, the shared ladder firing, the plan
// (repay-only from the Account's idle USDC, then a sale the keeper funds inside Kamino's 40 % cap), the signed
// transaction landing, the delegated ZEC collected, the store's record of it all, and observe-only refusing by name.
//
// Runs under `anchor test --skip-local-validator` with `bash scripts/localnet.sh` up and the agent built
// (`npm run build -w @zyo/agent`). The keeper key is generated here and written under fixtures/ (gitignored):
// a throwaway for a local ledger, never a real key.
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY, Transaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { expect } from "chai";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { KAMINO_ZCASH_MARKET, SOLANA_PROGRAMS, SOLANA_TOKENS, rungById } from "@zyo/shared";
import type { Oilskin } from "../target/types/oilskin";

// ts-node compiles this spec to CommonJS and rewrites `import()` into `require()`, which cannot load the ESM agent.
const importEsm = new Function("u", "return import(u)") as (u: string) => Promise<any>;
const agentUrl = (p: string) => pathToFileURL(resolve(__dirname, "../../agent/dist/src", p)).href;

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
const OB = { deposit0Amount: 96 + 32, borrow0AmountSf: 1208 + 88 };
const SF = 1n << 60n;
const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n);
const keyFile = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

interface Outcome {
  account: string;
  valuation: string;
  hf: number | null;
  fired: string | null;
  dispatch: { status: string; signature?: string; reason?: string; note?: string; error?: string } | null;
}
interface Report {
  discovered: number;
  evaluated: number;
  outcomes: Outcome[];
}

describe("keeper agent (localnet, the real reader/dispatcher/monitor against the cloned market)", function () {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Oilskin as Program<Oilskin>;
  const mockScope = new Program(require("../target/idl/mock_scope.json"), provider);
  const conn = provider.connection;

  const owner = Keypair.generate();
  const keeper = Keypair.generate();
  const zecAuthority = keyFile("fixtures/local-mint-authority.json");
  const usdcAuthority = keyFile("fixtures/local-usdc-mint-authority.json");
  const workDir = mkdtempSync(join(tmpdir(), "oilskin-keeper-"));
  const storePath = join(workDir, "store.json");
  const keeperKeyPath = resolve("fixtures/local-keeper.json");

  const [account] = PublicKey.findProgramAddressSync([Buffer.from("account"), owner.publicKey.toBuffer()], program.programId);
  const [userMetadata] = PublicKey.findProgramAddressSync([Buffer.from("user_meta"), account.toBuffer()], KLEND);
  const [obligation] = PublicKey.findProgramAddressSync([Buffer.from([0]), Buffer.from([0]), account.toBuffer(), MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()], KLEND);
  const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);
  const [grantPda] = PublicKey.findProgramAddressSync([Buffer.from("grant"), account.toBuffer(), keeper.publicKey.toBuffer()], program.programId);
  const ownerZec = getAssociatedTokenAddressSync(ZEC_MINT, owner.publicKey);
  const ownerUsdc = getAssociatedTokenAddressSync(USDC_MINT, owner.publicKey);
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

  /** Every write here is awaited to `confirmed`: the keeper reads at that commitment. */
  const confirmed = async (sig: string) => {
    const bh = await conn.getLatestBlockhash("confirmed");
    await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  };
  const stamp = async () => confirmed(await mockScope.methods.stampFresh(SCOPE_ENTRIES).accounts({ oraclePrices: SCOPE_PRICES, payer: provider.wallet.publicKey }).rpc());
  const setZecPrice = async (usd: number) => {
    const v = new BN(Math.round(usd * 1e8));
    for (const i of [R.ZEC.scopePriceChain[0], R.ZEC.scopeTwapChain[0]]) {
      await confirmed(await mockScope.methods.setPrice(i, v, new BN(8)).accounts({ oraclePrices: SCOPE_PRICES, payer: provider.wallet.publicKey }).rpc());
    }
    await stamp();
  };
  /** The obligation's cached amounts (moved by every op) — HF and LTV recomputed off-chain at `priceUsd`, the program's arithmetic. */
  const position = async (priceUsd: number) => {
    const info = await conn.getAccountInfo(obligation, "confirmed");
    if (!info) throw new Error("obligation missing");
    const deposited = info.data.readBigUInt64LE(OB.deposit0Amount);
    const usdcDebt = u128(info.data, OB.borrow0AmountSf) / SF;
    const collateralUsd = (Number(deposited) / 1e8) * priceUsd;
    const debtUsd = Number(usdcDebt) / 1e6;
    return { deposited, usdcDebt, hf: debtUsd === 0 ? Infinity : (collateralUsd * 0.65) / debtUsd, ltv: collateralUsd === 0 ? 0 : debtUsd / collateralUsd };
  };
  const balance = async (ata: PublicKey) => (await getAccount(conn, ata, "confirmed")).amount;
  const ownerCall = async (m: any) => confirmed(await m.preInstructions(cu).signers([owner]).rpc());
  const readStore = (p = storePath): { idCodec: string; accounts: any[]; dispatches: any[] } => JSON.parse(readFileSync(p, "utf8"));
  const mine = <T extends { account: string }>(xs: T[]) => xs.filter((x) => x.account === account.toBase58());

  let lastLines: string[] = [];
  /** One keeper run of `ticks` ticks, its own store; the Scope mock is stamped fresh first (klend's 180 s rule). */
  const runKeeper = async (o: { ticks: number; observeOnly?: boolean; storePath?: string }) => {
    const { runSolanaKeeper } = await importEsm(agentUrl("solana/keeper.js"));
    const { memorySink } = await importEsm(agentUrl("log.js"));
    const mem = memorySink();
    const reports: Report[] = [];
    const env: NodeJS.ProcessEnv = {
      SOLANA_RPC_URL: conn.rpcEndpoint,
      OILSKIN_SOLANA_PROGRAM_ID: program.programId.toBase58(),
      SOLANA_STORE_PATH: o.storePath ?? storePath,
      SOLANA_PRICE_SOURCE: "scope-only",
      KEEPER_MAX_SALE_USDC: (5_000n * ONE_USDC).toString(),
      HEALTH_POLL_MS: "500",
      LOG_LEVEL: "debug",
      ...(o.observeOnly ? { SOLANA_SIM_PAYER: keeper.publicKey.toBase58() } : { KEEPER_SOLANA_KEYPAIR: keeperKeyPath }),
    };
    await stamp();
    await runSolanaKeeper(env, { maxTicks: o.ticks, independent: null, sink: mem.sink, onTick: (r: Report) => reports.push(r) });
    lastLines = mem.lines;
    const last = reports[reports.length - 1];
    return { reports, outcome: last.outcomes.find((x) => x.account === account.toBase58())!, lines: mem.lines as string[] };
  };
  afterEach(function () {
    if (this.currentTest?.state === "failed") console.error("keeper log (tail):\n" + lastLines.slice(-25).join("\n"));
  });

  before(async () => {
    for (const [k, sol] of [[owner, 20], [keeper, 20]] as const) {
      await confirmed(await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL));
    }
    writeFileSync(keeperKeyPath, JSON.stringify(Array.from(keeper.secretKey)));
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ownerZec, owner.publicKey, ZEC_MINT),
      createMintToInstruction(ZEC_MINT, ownerZec, zecAuthority.publicKey, 10n * ONE_ZEC),
      createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, keeperUsdc, keeper.publicKey, USDC_MINT),
      createMintToInstruction(USDC_MINT, keeperUsdc, usdcAuthority.publicKey, 10_000n * ONE_USDC),
      createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, keeperZec, keeper.publicKey, ZEC_MINT)
    );
    await confirmed(await provider.sendAndConfirm(tx, [owner, keeper, zecAuthority, usdcAuthority]));
    await setZecPrice(1000);
    await ownerCall(program.methods.initAccount().accounts({ owner: owner.publicKey, account, zecMint: ZEC_MINT, usdcMint: USDC_MINT, accountZec, accountUsdc, userMetadata, obligation, lendingMarket: MARKET, klendProgram: KLEND, rent: SYSVAR_RENT_PUBKEY, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID } as any));
    await stamp();
    await ownerCall(program.methods.deposit(new BN((10n * ONE_ZEC).toString())).accounts({ owner: owner.publicKey, account, obligation, userMetadata, rent: SYSVAR_RENT_PUBKEY, systemProgram: SystemProgram.programId, ownerZec, accountZec, kamino, tokenProgram: TOKEN_PROGRAM_ID } as any));
    await stamp();
    // the top preset: 40 % of $10,000 → HF 1.625; the 3,990 USDC stays idle in the Account
    await ownerCall(program.methods.borrow(new BN((3_990n * ONE_USDC).toString())).accounts({ owner: owner.publicKey, account, obligation, accountUsdc, kamino } as any));
    // The grant, timed by the CHAIN clock (a warped localnet runs hours ahead of the host).
    const chainNow = (await conn.getBlockTime(await conn.getSlot("confirmed")))!;
    await confirmed(
      await program.methods
        .grant(keeper.publicKey, { expiryTs: new BN(chainNow + 86400 * 7), periodSecs: new BN(86400), repayUsdcPerPeriod: new BN((5_000n * ONE_USDC).toString()), sellZecPerPeriod: new BN((5n * ONE_ZEC).toString()), maxSellSlippageBps: 200, allowedRungs: 0b1111 })
        .accounts({ owner: owner.publicKey, account, grant: grantPda, systemProgram: SystemProgram.programId } as any)
        .signers([owner])
        .rpc()
    );
  });

  it("tick 1: discovers the Account by program-account scan, values it from one simulated refresh (HF ≈ 1.63), fires nothing, records the owner and the base58 codec", async () => {
    const { reports, outcome } = await runKeeper({ ticks: 1 });
    expect(reports.length).to.equal(1);
    expect(reports[0].discovered).to.be.greaterThanOrEqual(1);
    expect(outcome, "our Account was evaluated").to.not.equal(undefined);
    expect(outcome.valuation).to.equal("OK");
    expect(outcome.hf).to.be.closeTo(1.629, 0.01);
    expect(outcome.fired).to.equal(null);
    const s = readStore();
    expect(s.idCodec).to.equal("base58");
    const rec = mine(s.accounts)[0];
    expect(rec.owner).to.equal(owner.publicKey.toBase58());
    expect(rec.lastValuation).to.equal("OK");
    expect(rec.ladder.fired).to.deep.equal([]);
  });

  it("price −20 % (HF 1.30) crosses repay: the keeper plans repay-only from the Account's idle USDC, signs, sends and confirms; HF is lifted to the disarm level, not further; the grant's spend and the store record it", async () => {
    const keeperUsdc0 = await balance(keeperUsdc);
    const idle0 = await balance(accountUsdc);
    expect(idle0).to.equal(3_990n * ONE_USDC);
    await setZecPrice(800);
    const { outcome } = await runKeeper({ ticks: 1 });
    expect(outcome.valuation).to.equal("OK");
    expect(outcome.hf).to.be.closeTo(1.3, 0.01);
    expect(outcome.fired).to.equal("repay");
    expect(outcome.dispatch?.status, JSON.stringify(outcome.dispatch)).to.equal("CONFIRMED");
    const sig = outcome.dispatch!.signature!;
    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    expect(tx?.meta?.err ?? null, "the transaction landed without error").to.equal(null);
    // repay-only: the Account's own USDC paid, the keeper's did not move
    const idle1 = await balance(accountUsdc);
    expect(idle1 < idle0, "the Account's own USDC paid").to.equal(true);
    expect(await balance(keeperUsdc)).to.equal(keeperUsdc0);
    const repaid = idle0 - idle1;
    const p = await position(800);
    const disarm = rungById("repay").disarmHf;
    expect(p.hf, "at or above the disarm level").to.be.greaterThanOrEqual(disarm);
    expect(p.hf, "sized to the level (50 bps margin), not a blanket repay").to.be.lessThan(disarm + 0.03);
    const g = await program.account.grant.fetch(grantPda);
    expect(BigInt(g.repayUsdcSpent.toString())).to.equal(repaid);
    const d = mine(readStore().dispatches);
    expect(d.length).to.equal(1);
    expect(d[0].status).to.equal("CONFIRMED");
    expect(d[0].txHash).to.equal(sig);
    expect(d[0].rung).to.equal("repay");
    expect(d[0].attempts).to.equal(1);
  });

  it("the next tick at the same price fires nothing: the confirmed repay cleared its rung (warn stays fired below its own disarm level)", async () => {
    const { outcome } = await runKeeper({ ticks: 1 });
    expect(outcome.valuation).to.equal("OK");
    expect(outcome.fired).to.equal(null);
    expect(outcome.hf).to.be.greaterThanOrEqual(rungById("repay").disarmHf);
    const s = readStore();
    expect(mine(s.accounts)[0].ladder.fired).to.deep.equal(["warn"]);
    expect(mine(s.dispatches).length).to.equal(1);
  });

  it("price −34 % (HF ≈ 1.16) crosses de-risk with the idle USDC gone: the keeper pays USDC in at the Scope price, the program repays it and releases ZEC inside Kamino's 40 % cap, and the keeper collects exactly the ZEC delegated", async () => {
    // the owner takes the idle USDC home first, so the Account has nothing of its own to repay with
    const idle = await balance(accountUsdc);
    await confirmed(
      await program.methods
        .transferOut(new BN(idle.toString()))
        .accounts({ owner: owner.publicKey, account, mint: USDC_MINT, accountToken: accountUsdc, ownerToken: ownerUsdc, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId } as any)
        .signers([owner])
        .rpc()
    );
    expect(await balance(accountUsdc)).to.equal(0n);
    const keeperUsdc0 = await balance(keeperUsdc);
    const keeperZec0 = await balance(keeperZec);
    const before = await position(660);
    expect(before.hf).to.be.closeTo(1.16, 0.02);
    await setZecPrice(660);
    const { outcome } = await runKeeper({ ticks: 1 });
    expect(outcome.fired).to.equal("derisk");
    expect(outcome.dispatch?.status, JSON.stringify(outcome.dispatch)).to.equal("CONFIRMED");
    expect(outcome.dispatch!.note ?? "").to.match(/collected \d+ ZEC base units/);
    const paid = keeperUsdc0 - (await balance(keeperUsdc));
    const collected = (await balance(keeperZec)) - keeperZec0;
    expect(paid > 0n, "the keeper paid USDC in").to.equal(true);
    expect(collected > 0n, "the keeper received ZEC").to.equal(true);
    // fair value at the Scope price (no discount configured): USDC paid ≈ ZEC received × $660
    const fair = (Number(collected) / 1e8) * 660 * 1e6;
    expect(Number(paid)).to.be.closeTo(fair, fair * 0.001 + 2);
    const after = await position(660);
    expect(after.hf, "at or above de-risk's disarm level").to.be.greaterThanOrEqual(rungById("derisk").disarmHf);
    expect(after.ltv, "inside Kamino's 40 % cap, which binds before our level").to.be.lessThanOrEqual(0.4 + 1e-4);
    expect(Number(before.usdcDebt - after.usdcDebt), "every USDC the keeper paid went to the debt").to.be.closeTo(Number(paid), 10);
    expect(before.deposited - after.deposited, "the collateral released equals the ZEC collected").to.equal(collected);
    const acctZec = await getAccount(conn, accountZec, "confirmed");
    expect(acctZec.amount, "nothing released is left in the Account").to.equal(0n);
    expect(acctZec.delegatedAmount, "nothing is left delegated").to.equal(0n);
    const g = await program.account.grant.fetch(grantPda);
    expect(BigInt(g.sellZecSpent.toString())).to.equal(collected);
    const d = mine(readStore().dispatches);
    expect(d.length).to.equal(2);
    expect(d[1].rung).to.equal("derisk");
    expect(d[1].status).to.equal("CONFIRMED");
  });

  it("observe-only (no keeper key): a fresh store sees the same chain; a further fall is recorded and REFUSED by name; nothing is signed", async () => {
    const keeperUsdc0 = await balance(keeperUsdc);
    const debt0 = (await position(528)).usdcDebt;
    await setZecPrice(528); // −20 % from the post-sale level (HF 1.625 → 1.30)
    const observeStore = join(workDir, "observe.json");
    const { outcome } = await runKeeper({ ticks: 1, observeOnly: true, storePath: observeStore });
    expect(outcome.valuation).to.equal("OK");
    expect(outcome.hf).to.be.closeTo(1.3, 0.01);
    expect(outcome.fired).to.equal("repay");
    expect(outcome.dispatch?.status).to.equal("REFUSED");
    expect(outcome.dispatch?.reason ?? "").to.match(/observe-only/);
    const d = mine(readStore(observeStore).dispatches)[0];
    expect(d.status).to.equal("REFUSED");
    expect(d.txHash).to.equal(undefined);
    expect(await balance(keeperUsdc)).to.equal(keeperUsdc0);
    expect((await position(528)).usdcDebt).to.equal(debt0);
  });
});
