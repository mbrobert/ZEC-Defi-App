// Read-only: who mints bridged ZEC (the bridge program, through its PDA authority), and who can upgrade each
// program in the trust path (klend, Scope, Farms, Wormhole core, the bridge program). Nothing signed.
//
//   SOLANA_RPC_URL=<rpc> node solana/scripts/read-authorities.mjs     → solana/.facts/authorities.json
import { PublicKey } from "@solana/web3.js";
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function raw(method, params) {
  const res = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json(); if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`); return j.result;
}
const ZEC_MINT = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
const AUTH = "FvULawNPGBbuwYus74ECaQoV1oH9Tk6XPN7VPN51NYds";
const out = { mintEvents: [], programs: {} };
const sigs = await raw("getSignaturesForAddress", [AUTH, { limit: 8, commitment: "finalized" }]);
const seenPrograms = new Set();
for (const s of sigs) {
  if (s.err) continue;
  await sleep(500);
  const tx = await raw("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }]);
  if (!tx) continue;
  const top = tx.transaction.message.instructions;
  const inner = tx.meta?.innerInstructions ?? [];
  const events = [];
  const scan = (ix, where, outer) => {
    if (ix.program === "spl-token" && ix.parsed && ix.parsed.info?.mint === ZEC_MINT && /mintTo|burn/i.test(ix.parsed.type)) {
      events.push({ type: ix.parsed.type, amountBase: ix.parsed.info.amount ?? ix.parsed.info.tokenAmount?.amount, authority: ix.parsed.info.mintAuthority ?? ix.parsed.info.authority, outerProgram: outer, where });
    }
  };
  top.forEach((ix, i) => scan(ix, `top#${i}`, ix.programId));
  for (const grp of inner) for (const ix of grp.instructions) scan(ix, `inner-of-top#${grp.index}`, top[grp.index]?.programId);
  const progs = [...new Set(top.map((ix) => ix.programId))];
  progs.forEach((p) => seenPrograms.add(p));
  const logs = (tx.meta?.logMessages ?? []).filter((l) => /invoke \[1\]/.test(l)).map((l) => l.replace(/ invoke \[1\]/, ""));
  out.mintEvents.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime, iso: new Date(s.blockTime * 1000).toISOString(), topLevelPrograms: progs, topLevelInvokes: [...new Set(logs)], events });
}
// Upgrade authorities: BPF upgradeable loader → program account points at programdata; programdata[4..12]=slot, [12]=option, [13..45]=authority.
const PROGRAMS = {
  klend: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
  scope: "HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ",
  farms: "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr",
  wormholeCore: "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth",
};
for (const p of seenPrograms) if (!Object.values(PROGRAMS).includes(p) && p !== "11111111111111111111111111111111" && p !== "ComputeBudget111111111111111111111111111111" && p !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" && p !== "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL") PROGRAMS[`seen:${p}`] = p;
for (const [name, id] of Object.entries(PROGRAMS)) {
  await sleep(400);
  const acct = await raw("getAccountInfo", [id, { encoding: "base64", commitment: "finalized" }]);
  const rec = { id, executable: acct?.value?.executable ?? null, owner: acct?.value?.owner ?? null };
  if (acct?.value?.owner === "BPFLoaderUpgradeab1e11111111111111111111111") {
    const data = Buffer.from(acct.value.data[0], "base64");
    const programData = new PublicKey(data.subarray(4, 36)).toBase58();
    await sleep(400);
    const pd = await raw("getAccountInfo", [programData, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 45 } }]);
    const b = Buffer.from(pd.value.data[0], "base64");
    rec.programData = programData;
    rec.lastDeploySlot = Number(b.readBigUInt64LE(4));
    rec.upgradeAuthority = b[12] === 1 ? new PublicKey(b.subarray(13, 45)).toBase58() : null;
    if (rec.upgradeAuthority) {
      await sleep(400);
      const ua = await raw("getAccountInfo", [rec.upgradeAuthority, { encoding: "jsonParsed", commitment: "finalized" }]);
      rec.upgradeAuthorityOwner = ua?.value?.owner ?? null;
      rec.upgradeAuthorityOnCurve = PublicKey.isOnCurve(new PublicKey(rec.upgradeAuthority).toBytes());
      const parsed = ua?.value?.data?.parsed;
      if (parsed) rec.upgradeAuthorityParsed = JSON.stringify(parsed).slice(0, 400);
      // Squads multisig programs: SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu (v3), SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf (v4)
      if (ua?.value?.owner === "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf") rec.upgradeAuthorityKind = "Squads v4 multisig-owned account";
      else if (ua?.value?.owner === "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu") rec.upgradeAuthorityKind = "Squads v3 multisig-owned account";
      else if (ua?.value?.owner === "11111111111111111111111111111111" && rec.upgradeAuthorityOnCurve) rec.upgradeAuthorityKind = "plain keypair (system-owned, on curve)";
      else rec.upgradeAuthorityKind = `owned by ${ua?.value?.owner}`;
    }
  }
  out.programs[name] = rec;
  console.log(name, JSON.stringify(rec));
}
// Is the ZEC mint authority a PDA of one of the seen programs? Try to find it via the minting tx's CPI signer chain: reported above as outerProgram.
console.log("MINT EVENTS", JSON.stringify(out.mintEvents, null, 1));
import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync(new URL("../.facts/", import.meta.url), { recursive: true });
writeFileSync(new URL("../.facts/authorities.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("WROTE solana/.facts/authorities.json");
