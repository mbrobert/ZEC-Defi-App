// The keeper's hand-written Solana encoders pinned to the program's committed IDL — the twin of verify-abi.mjs.
// Runs inside `npm test -w @zyo/agent` (after tsc, so it reads dist/). Exit 1 on any drift.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const idlPath = join(here, "..", "..", "solana", "idl", "oilskin.json");
if (!existsSync(idlPath)) {
  console.error(`verify-solana-idl: ${idlPath} missing (run: node solana/scripts/sync-idl.mjs)`);
  process.exit(1);
}
const idl = JSON.parse(readFileSync(idlPath, "utf8"));
const L = await import(join(here, "..", "dist", "src", "solana", "layouts.js"));

let checks = 0;
let failures = 0;
const check = (label, ok, detail = "") => {
  checks++;
  if (!ok) {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const eq = (a, b) => JSON.stringify([...a]) === JSON.stringify([...b]);

// instruction discriminators
const ix = (n) => idl.instructions.find((i) => i.name === n);
check("keeper_protect discriminator", eq(L.OILSKIN_IX.keeperProtect, ix("keeper_protect").discriminator));
check("keeper_protect args", JSON.stringify(ix("keeper_protect").args.map((a) => [a.name, a.type])) === JSON.stringify([["rung_id", "u8"], ["repay_usdc", "u64"], ["sell_zec", "u64"]]));
// account discriminators
const acc = (n) => idl.accounts.find((a) => a.name === n);
check("UserAccount discriminator", eq(L.OILSKIN_ACCOUNT.userAccount, acc("UserAccount").discriminator));
check("Grant discriminator", eq(L.OILSKIN_ACCOUNT.grant, acc("Grant").discriminator));
// account order of keeper_protect
const flat = (accs, p = "") => accs.flatMap((a) => (a.accounts ? flat(a.accounts, p + a.name + ".") : [p + a.name]));
const order = flat(ix("keeper_protect").accounts);
check("keeper_protect account order", JSON.stringify(order) === JSON.stringify([...L.KEEPER_PROTECT_ACCOUNT_ORDER]), `idl=${order.join(",")}`);
// writable/signer flags as encoded
const { PublicKey } = await import("@solana/web3.js");
const k = new PublicKey("11111111111111111111111111111112");
const built = L.ixKeeperProtect({ program: k, keeper: k, account: k, grant: k, obligation: k, accountZec: k, accountUsdc: k }, 1, 1n, 0n);
const idlAccs = flat(ix("keeper_protect").accounts.map((a) => a)).map((n) => n);
const flagsOf = (accs, p = "") => accs.flatMap((a) => (a.accounts ? flagsOf(a.accounts, p + a.name + ".") : [{ name: p + a.name, writable: !!a.writable, signer: !!a.signer }]));
const idlFlags = flagsOf(ix("keeper_protect").accounts);
check("keeper_protect key count", built.keys.length === idlFlags.length, `${built.keys.length} vs ${idlFlags.length}`);
idlFlags.forEach((f, i) => {
  const key = built.keys[i];
  if (!key) return;
  check(`keeper_protect[${i}] ${f.name} writable`, key.isWritable === f.writable, `encoded ${key.isWritable}, idl ${f.writable}`);
  check(`keeper_protect[${i}] ${f.name} signer`, key.isSigner === f.signer, `encoded ${key.isSigner}, idl ${f.signer}`);
});
// data layout: 8 + 1 + 8 + 8
check("keeper_protect data length", built.data.length === 25, `${built.data.length}`);
// layout sizes vs IDL types
const sizeOf = (t) => (typeof t === "string" ? { u8: 1, u16: 2, u64: 8, i64: 8, pubkey: 32 }[t] : t.array ? sizeOf(t.array[0]) * t.array[1] : NaN);
const typeSize = (name) => 8 + idl.types.find((t) => t.name === name).type.fields.reduce((s, f) => s + sizeOf(f.type), 0);
check("UserAccount length", L.USER_ACCOUNT_LEN === typeSize("UserAccount"), `${L.USER_ACCOUNT_LEN} vs ${typeSize("UserAccount")}`);
check("Grant length", L.GRANT_LEN === typeSize("Grant"), `${L.GRANT_LEN} vs ${typeSize("Grant")}`);
// klend discriminators are sha256("global:<name>")[..8] — recompute
const disc = (n) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
check("klend refresh_reserve discriminator", eq(L.KLEND_IX.refreshReserve, disc("refresh_reserve")));
check("klend refresh_obligation discriminator", eq(L.KLEND_IX.refreshObligation, disc("refresh_obligation")));
const adisc = (n) => createHash("sha256").update(`account:${n}`).digest().subarray(0, 8);
check("klend Obligation account discriminator", eq(L.KLEND_ACCOUNT.obligation, adisc("Obligation")));
check("klend Reserve account discriminator", eq(L.KLEND_ACCOUNT.reserve, adisc("Reserve")));
check("program errors table present", Array.isArray(idl.errors) && idl.errors.some((e) => e.name === "ProtectionIneffective"));
for (const e of L.OILSKIN_ERRORS) {
  const idlErr = idl.errors.find((x) => x.name === e.name);
  check(`error ${e.name} code`, !!idlErr && idlErr.code === e.code, `encoded ${e.code}, idl ${idlErr?.code}`);
}

console.log(`verify-solana-idl: ${checks - failures}/${checks} checks passed against ${idl.address}`);
process.exit(failures ? 1 : 0);
