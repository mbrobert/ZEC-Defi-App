// Localnet smoke test: the cloned ZCASH-market world is present and the two fixtures took effect.
// Runs under `anchor test --skip-local-validator` after `bash scripts/localnet.sh` (see SETUP.md). It proves
// the harness, not the program — there are no instruction handlers yet (docs/SOLANA-ARCHITECTURE.md, status).
import { Connection, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const SCOPE = new PublicKey("HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ");
const MARKET = new PublicKey("GBJ3bzUiMfwC9ugaF3MM68EXMDyTUb5UryRRAcVjEowd");
const RESERVES = ["6e8XcrdencrXBjXtTqYkRS63nS36petvzkV3gBf2ezbH", "EW9vT7g2VH2aTFfcbaXRUCbF7jEfaLwMiJpckwDZwUZd"].map((s) => new PublicKey(s));
const SCOPE_PRICES = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
const ZEC_MINT = new PublicKey("A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS");
const BRIDGE_PDA_AUTHORITY = "FvULawNPGBbuwYus74ECaQoV1oH9Tk6XPN7VPN51NYds";

const connection = new Connection(process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899", "confirmed");

describe("localnet world (cloned from mainnet, fixtures applied)", () => {
  it("klend and Scope are executable", async () => {
    for (const p of [KLEND, SCOPE]) {
      const a = await connection.getAccountInfo(p);
      expect(a, p.toBase58()).to.not.equal(null);
      expect(a!.executable).to.equal(true);
    }
  });

  it("the ZCASH market and both reserves are owned by klend with the mainnet sizes", async () => {
    const m = await connection.getAccountInfo(MARKET);
    expect(m!.owner.equals(KLEND)).to.equal(true);
    expect(m!.data.length).to.equal(4664);
    for (const r of RESERVES) {
      const a = await connection.getAccountInfo(r);
      expect(a!.owner.equals(KLEND)).to.equal(true);
      expect(a!.data.length).to.equal(8624);
      expect(new PublicKey(a!.data.subarray(32, 64)).equals(MARKET)).to.equal(true);
    }
  });

  it("Scope OraclePrices entry 430 carries the far-future timestamp the fixture wrote", async () => {
    const a = await connection.getAccountInfo(SCOPE_PRICES);
    expect(a!.owner.equals(SCOPE)).to.equal(true);
    expect(a!.data.length).to.equal(28712);
    const o = 40 + 430 * 56;
    const ts = a!.data.readBigUInt64LE(o + 24);
    expect(ts).to.equal(4_102_444_800n);
    const exp = a!.data.readBigUInt64LE(o + 8);
    expect(Number(exp)).to.equal(8);
  });

  it("the ZEC mint's authority is the local test key, not the bridge PDA", async () => {
    const a = await connection.getAccountInfo(ZEC_MINT);
    expect(a!.data.length).to.equal(82);
    expect(a!.data.readUInt32LE(0)).to.equal(1);
    const authority = new PublicKey(a!.data.subarray(4, 36)).toBase58();
    expect(authority).to.not.equal(BRIDGE_PDA_AUTHORITY);
    expect(a!.data.readUInt32LE(46)).to.equal(0, "no freeze authority, as on mainnet");
  });
});
