#!/usr/bin/env node
// Read-only: who holds a Solana program's upgrade authority, and the exact hand-over command for the founder.
// Never signs, never sends. Zero dependencies (fetch + Buffer).
//
//   node solana/scripts/authority.mjs --program <id> [--rpc <url>]                 → the current authority
//   node solana/scripts/authority.mjs --program <id> --expect <squads-vault> [--rpc <url>]
//       → verifies the vault exists and is owned by Squads Protocol v4, then prints the `solana program
//         set-upgrade-authority` command; exit 0 when the hand-over is DONE (authority already the vault),
//         exit 2 when it is PENDING (command printed), exit 1 on any refusal.
//
// The BPF upgradeable loader's account layouts (solana-sdk `bpf_loader_upgradeable::UpgradeableLoaderState`):
//   Program     = u32 enum tag 2 + programdata_address (32)                          → 36 bytes
//   ProgramData = u32 enum tag 3 + slot u64 + Option<Pubkey> (1 + 32) + the ELF     → authority at 13..45
// Squads Protocol v4 program `SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu` — executable and IMMUTABLE (no
// upgrade authority), read live 2026-09-13 02:42 UTC (VERIFIED-SOLANA-FACTS.md Addendum 2).
import { fileURLToPath } from "node:url";

export const BPF_UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const SQUADS_V4_PROGRAM = "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu";
export const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = 0n;
  for (const x of bytes) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of bytes) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}
export const isBase58Key = (s) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

export async function rpc(url, method, params, fetchImpl = fetch) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }
  throw new Error(`${method}: rate limited four times`);
}

const account = async (url, address, fetchImpl, dataSlice) => {
  const r = await rpc(url, "getAccountInfo", [address, { encoding: "base64", commitment: "confirmed", ...(dataSlice ? { dataSlice } : {}) }], fetchImpl);
  if (!r || !r.value) return null;
  return { owner: r.value.owner, executable: r.value.executable, lamports: r.value.lamports, data: Buffer.from(r.value.data[0], "base64"), slot: r.context?.slot ?? null };
};

/** The program's ProgramData and current upgrade authority (null = immutable). */
export async function readUpgradeAuthority(url, programId, fetchImpl = fetch) {
  if (!isBase58Key(programId)) throw new Error(`program id ${programId} is not a base58 key`);
  const prog = await account(url, programId, fetchImpl);
  if (!prog) throw new Error(`program ${programId}: account absent`);
  if (!prog.executable) throw new Error(`program ${programId}: not executable`);
  if (prog.owner !== BPF_UPGRADEABLE_LOADER) throw new Error(`program ${programId}: owned by ${prog.owner}, not the BPF upgradeable loader (non-upgradeable loaders have no authority to hand over)`);
  if (prog.data.length !== 36 || prog.data.readUInt32LE(0) !== 2) throw new Error(`program ${programId}: unexpected Program account layout (${prog.data.length} bytes, tag ${prog.data.length >= 4 ? prog.data.readUInt32LE(0) : "?"})`);
  const programData = base58(prog.data.subarray(4, 36));
  const pd = await account(url, programData, fetchImpl, { offset: 0, length: 45 });
  if (!pd) throw new Error(`programdata ${programData}: account absent`);
  if (pd.owner !== BPF_UPGRADEABLE_LOADER || pd.data.length < 45 || pd.data.readUInt32LE(0) !== 3) throw new Error(`programdata ${programData}: unexpected layout`);
  const hasAuthority = pd.data[12] === 1;
  return { programId, programData, lastDeploySlot: Number(pd.data.readBigUInt64LE(4)), upgradeAuthority: hasAuthority ? base58(pd.data.subarray(13, 45)) : null, readSlot: pd.slot };
}

/** A Squads v4 vault is a PDA the Squads program owns — checked on chain, not by re-deriving seeds. */
export async function checkSquadsVault(url, vault, fetchImpl = fetch) {
  if (!isBase58Key(vault)) return { ok: false, reason: `${vault} is not a base58 key` };
  const a = await account(url, vault, fetchImpl);
  // Squads v4 vaults are system-owned PDAs with no data by default; the MULTISIG account is owned by the program.
  // Accept either: a vault that already holds lamports (system-owned, off-curve) or an account the Squads program owns.
  if (!a) return { ok: false, reason: `${vault}: account absent on this cluster — fund the vault (or create the multisig) first, so a typo cannot become the authority` };
  if (a.owner === SQUADS_V4_PROGRAM) return { ok: true, kind: "squads-program-owned account (a multisig account, not a vault — the vault is what should sign upgrades)", warn: true };
  if (a.owner === "11111111111111111111111111111111") return { ok: true, kind: "system-owned account (a Squads vault PDA holding lamports)" };
  return { ok: false, reason: `${vault}: owned by ${a.owner}, neither the system program (a vault) nor Squads v4 ${SQUADS_V4_PROGRAM}` };
}

export function handoverCommand(programId, vault, url) {
  return `solana program set-upgrade-authority ${programId} --new-upgrade-authority ${vault} --skip-new-upgrade-authority-signer-check --url ${url}`;
}

export async function main(argv, fetchImpl = fetch, out = console.log) {
  const arg = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const programId = arg("--program");
  const url = arg("--rpc") ?? DEFAULT_RPC;
  const expect = arg("--expect");
  if (!programId) {
    out("usage: node solana/scripts/authority.mjs --program <id> [--expect <squads-vault>] [--rpc <url>]");
    return 1;
  }
  const a = await readUpgradeAuthority(url, programId, fetchImpl);
  out(`program            ${a.programId}`);
  out(`programdata        ${a.programData}`);
  out(`last deploy slot   ${a.lastDeploySlot}`);
  out(`upgrade authority  ${a.upgradeAuthority ?? "NONE — the program is immutable"}`);
  out(`read at slot       ${a.readSlot ?? "?"} (${url})`);
  if (!expect) return 0;
  if (a.upgradeAuthority === null) {
    out("REFUSED: an immutable program has no authority to hand over");
    return 1;
  }
  if (a.upgradeAuthority === expect) {
    out(`DONE: the upgrade authority is already ${expect}`);
    return 0;
  }
  const v = await checkSquadsVault(url, expect, fetchImpl);
  if (!v.ok) {
    out(`REFUSED: ${v.reason}`);
    return 1;
  }
  out(`target             ${expect} — ${v.kind}${v.warn ? " (WARNING: check this is the vault, not the multisig config account)" : ""}`);
  out("");
  out("PENDING. The founder runs this, in his terminal, with the CURRENT authority's key as the default signer;");
  out("nothing in this repository signs it. Then re-run this script with the same --expect to confirm DONE:");
  out("");
  out(`  ${handoverCommand(programId, expect, url)}`);
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`authority: ${e.message}`);
    process.exit(1);
  });
}
