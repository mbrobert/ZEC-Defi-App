// The hand-over script against a fake RPC: the loader layouts decoded, the vault checked by owner, the command
// printed only when the hand-over is pending, refusals by name. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { base58, BPF_UPGRADEABLE_LOADER, checkSquadsVault, handoverCommand, main, readUpgradeAuthority, SQUADS_V4_PROGRAM } from "../scripts/authority.mjs";

const PROGRAM = "Gw2UE3MixYgA8c7nLZC9UF2z3z5dWfzrFW7ESmi5Scog";
const VAULT = "7Y5m2Jd3Q3s7VqkY9iZ8Y4cV7c3d9RrXk2wLp1nQ4bBz";
const DEPLOYER = "A11EznxnJM3JrjUvAq16wqoVyPRNz522mdQm6mSmzMeR";
const SYSTEM = "11111111111111111111111111111111";

/** Decode base58 (test-only helper; the script never needs to decode). */
function fromBase58(s) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Buffer.from(out);
}
const programAccount = (programData) => Buffer.concat([Buffer.from([2, 0, 0, 0]), fromBase58(programData)]);
const programDataAccount = (slot, authority) => {
  const b = Buffer.alloc(45);
  b.writeUInt32LE(3, 0);
  b.writeBigUInt64LE(BigInt(slot), 4);
  if (authority) {
    b[12] = 1;
    fromBase58(authority).copy(b, 13);
  }
  return b;
};
const PROGRAMDATA = base58(Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)));

function fakeRpc(accounts) {
  const calls = [];
  const f = async (_url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req.params[0]);
    const a = accounts[req.params[0]];
    const value = a ? { owner: a.owner, executable: !!a.executable, lamports: a.lamports ?? 1, data: [a.data.toString("base64"), "base64"] } : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 446_600_000 }, value } }));
  };
  return { fetch: f, calls };
}

test("base58 of 32 bytes matches the known encodings", () => {
  assert.equal(base58(fromBase58(PROGRAM)), PROGRAM);
  assert.equal(base58(fromBase58(SQUADS_V4_PROGRAM)), SQUADS_V4_PROGRAM);
  assert.equal(base58(Buffer.alloc(32)), SYSTEM);
});

test("reads the loader's Program → ProgramData chain and the Option<Pubkey> authority; NONE means immutable", async () => {
  const held = fakeRpc({ [PROGRAM]: { owner: BPF_UPGRADEABLE_LOADER, executable: true, data: programAccount(PROGRAMDATA) }, [PROGRAMDATA]: { owner: BPF_UPGRADEABLE_LOADER, data: programDataAccount(447_000_000, DEPLOYER) } });
  const a = await readUpgradeAuthority("http://rpc", PROGRAM, held.fetch);
  assert.deepEqual(a, { programId: PROGRAM, programData: PROGRAMDATA, lastDeploySlot: 447_000_000, upgradeAuthority: DEPLOYER, readSlot: 446_600_000 });
  assert.deepEqual(held.calls, [PROGRAM, PROGRAMDATA]);
  const immutable = fakeRpc({ [PROGRAM]: { owner: BPF_UPGRADEABLE_LOADER, executable: true, data: programAccount(PROGRAMDATA) }, [PROGRAMDATA]: { owner: BPF_UPGRADEABLE_LOADER, data: programDataAccount(178_977_035, null) } });
  assert.equal((await readUpgradeAuthority("http://rpc", PROGRAM, immutable.fetch)).upgradeAuthority, null);
});

test("refusals by name: absent, not executable, a non-upgradeable loader, a malformed layout, a bad key", async () => {
  await assert.rejects(readUpgradeAuthority("http://rpc", PROGRAM, fakeRpc({}).fetch), /account absent/);
  await assert.rejects(readUpgradeAuthority("http://rpc", PROGRAM, fakeRpc({ [PROGRAM]: { owner: BPF_UPGRADEABLE_LOADER, executable: false, data: programAccount(PROGRAMDATA) } }).fetch), /not executable/);
  await assert.rejects(readUpgradeAuthority("http://rpc", PROGRAM, fakeRpc({ [PROGRAM]: { owner: "BPFLoader2111111111111111111111111111111111", executable: true, data: Buffer.alloc(10) } }).fetch), /not the BPF upgradeable loader/);
  await assert.rejects(readUpgradeAuthority("http://rpc", PROGRAM, fakeRpc({ [PROGRAM]: { owner: BPF_UPGRADEABLE_LOADER, executable: true, data: Buffer.alloc(36) } }).fetch), /unexpected Program account layout/);
  await assert.rejects(readUpgradeAuthority("http://rpc", "not-a-key", fakeRpc({}).fetch), /not a base58 key/);
});

test("the vault check is by owner on chain: a funded system-owned PDA passes, an absent account or a foreign owner is refused, a Squads-owned account passes with a warning", async () => {
  assert.equal((await checkSquadsVault("http://rpc", VAULT, fakeRpc({ [VAULT]: { owner: SYSTEM, data: Buffer.alloc(0), lamports: 5_000_000 } }).fetch)).ok, true);
  const absent = await checkSquadsVault("http://rpc", VAULT, fakeRpc({}).fetch);
  assert.equal(absent.ok, false);
  assert.match(absent.reason, /absent/);
  const foreign = await checkSquadsVault("http://rpc", VAULT, fakeRpc({ [VAULT]: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: Buffer.alloc(165) } }).fetch);
  assert.equal(foreign.ok, false);
  const config = await checkSquadsVault("http://rpc", VAULT, fakeRpc({ [VAULT]: { owner: SQUADS_V4_PROGRAM, data: Buffer.alloc(300) } }).fetch);
  assert.equal(config.ok, true);
  assert.equal(config.warn, true);
  assert.equal((await checkSquadsVault("http://rpc", "nope", fakeRpc({}).fetch)).ok, false);
});

test("main: PENDING prints the exact set-upgrade-authority command and exits 2; DONE exits 0; an immutable program or a bad vault exits 1; nothing is ever sent", async () => {
  const lines = [];
  const out = (l) => lines.push(l);
  const chain = { [PROGRAM]: { owner: BPF_UPGRADEABLE_LOADER, executable: true, data: programAccount(PROGRAMDATA) }, [PROGRAMDATA]: { owner: BPF_UPGRADEABLE_LOADER, data: programDataAccount(447_000_000, DEPLOYER) }, [VAULT]: { owner: SYSTEM, data: Buffer.alloc(0), lamports: 1 } };
  const rpc1 = fakeRpc(chain);
  assert.equal(await main(["--program", PROGRAM, "--expect", VAULT, "--rpc", "http://rpc"], rpc1.fetch, out), 2);
  assert.ok(lines.some((l) => l.includes("PENDING")));
  assert.ok(lines.some((l) => l.trim() === handoverCommand(PROGRAM, VAULT, "http://rpc")));
  assert.equal(handoverCommand(PROGRAM, VAULT, "http://rpc"), `solana program set-upgrade-authority ${PROGRAM} --new-upgrade-authority ${VAULT} --skip-new-upgrade-authority-signer-check --url http://rpc`);
  assert.ok(rpc1.calls.every((c) => typeof c === "string"), "only getAccountInfo reads");
  const done = fakeRpc({ ...chain, [PROGRAMDATA]: { owner: BPF_UPGRADEABLE_LOADER, data: programDataAccount(447_000_001, VAULT) } });
  lines.length = 0;
  assert.equal(await main(["--program", PROGRAM, "--expect", VAULT, "--rpc", "http://rpc"], done.fetch, out), 0);
  assert.ok(lines.some((l) => l.startsWith("DONE")));
  const immutable = fakeRpc({ ...chain, [PROGRAMDATA]: { owner: BPF_UPGRADEABLE_LOADER, data: programDataAccount(1, null) } });
  assert.equal(await main(["--program", PROGRAM, "--expect", VAULT, "--rpc", "http://rpc"], immutable.fetch, out), 1);
  const badVault = fakeRpc({ [PROGRAM]: chain[PROGRAM], [PROGRAMDATA]: chain[PROGRAMDATA] });
  assert.equal(await main(["--program", PROGRAM, "--expect", VAULT, "--rpc", "http://rpc"], badVault.fetch, out), 1);
  assert.equal(await main([], fakeRpc({}).fetch, out), 1, "usage");
  assert.equal(await main(["--program", PROGRAM, "--rpc", "http://rpc"], fakeRpc(chain).fetch, out), 0, "read-only mode without --expect");
});
