// Localnet mint fixtures (read-only against mainnet; writes JSON files solana-test-validator loads with --account).
//
//   node scripts/patch-scope-fixture.mjs --out fixtures --zec-mint-authority <pubkey> [--usdc-mint-authority <pubkey>]
//       → fixtures/zec-mint.json  : the bridged ZEC mint with its mint authority replaced by a local test key
//                                   (on mainnet the authority is the bridge program's PDA, so nothing can mint locally)
//       → fixtures/usdc-mint.json : USDC with its mint authority replaced by a local test key (mainnet: Circle's),
//                                   so close_position tests can top up the accrued interest
//
// Scope prices are NOT patched here any more: klend overflows on a future-dated timestamp (last_update.rs:96),
// so the harness runs `programs/mock_scope` at Scope's program id instead and the tests stamp prices fresh.
// The file keeps its historical name because docs and scripts reference it.
//
// SPL Mint layout (82 bytes): COption<Pubkey> mint_authority at 0..36, supply u64 at 36, decimals u8 at 44,
// is_initialized at 45, COption<Pubkey> freeze_authority at 46..82.
import { mkdirSync, writeFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const outDir = opt("--out", "fixtures");
mkdirSync(outDir, { recursive: true });

const ZEC_MINT = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function raw(method, params) {
  const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function fetchAccount(address) {
  const a = await raw("getAccountInfo", [address, { encoding: "base64", commitment: "finalized" }]);
  if (!a?.value) throw new Error(`${address}: no account`);
  // rentEpoch is written as 0: the validator rejects u64::MAX in an --account file.
  return { data: Buffer.from(a.value.data[0], "base64"), lamports: a.value.lamports, owner: a.value.owner, executable: a.value.executable, rentEpoch: 0 };
}
function writeFixture(file, address, acct, data) {
  const json = { pubkey: address, account: { lamports: acct.lamports, data: [data.toString("base64"), "base64"], owner: acct.owner, executable: acct.executable, rentEpoch: acct.rentEpoch, space: data.length } };
  writeFileSync(file, JSON.stringify(json, null, 2));
  console.log(`wrote ${file} (${address}, ${data.length} bytes)`);
}
async function patchMint(mint, authority, file, label) {
  const pk = new PublicKey(authority); // validates base58 / 32 bytes
  const acct = await fetchAccount(mint);
  const b = Buffer.from(acct.data);
  if (b.length !== 82) throw new Error(`unexpected mint length ${b.length}`);
  b.writeUInt32LE(1, 0); // COption::Some
  pk.toBuffer().copy(b, 4);
  writeFixture(`${outDir}/${file}`, mint, acct, b);
  console.log(`${label} mint authority set to ${authority} (local test key)`);
}

let did = false;
const zecAuth = opt("--zec-mint-authority", null);
if (zecAuth) { await patchMint(ZEC_MINT, zecAuth, "zec-mint.json", "ZEC"); did = true; }
const usdcAuth = opt("--usdc-mint-authority", null);
if (usdcAuth) { await patchMint(USDC_MINT, usdcAuth, "usdc-mint.json", "USDC"); did = true; }
if (!did) {
  console.error("nothing to do: pass --zec-mint-authority <pubkey> and/or --usdc-mint-authority <pubkey>");
  process.exit(2);
}
