// Localnet fixtures (read-only against mainnet; writes JSON files solana-test-validator loads with --account).
//
//   node scripts/patch-scope-fixture.mjs --out fixtures --future-timestamps [--zec-price 800]
//       → fixtures/scope-oracle-prices.json : Scope OraclePrices with entries 430/429/13/456 stamped fresh
//         (unix_timestamp far in the future, last_updated_slot 0) so Kamino's `now − ts > max_age` check
//         reads fresh on a validator whose clock starts at wall time. Optional --zec-price rewrites entry 430
//         and 429 to a chosen USD price (8-dp value, exp 8) to simulate a drawdown.
//   node scripts/patch-scope-fixture.mjs --out fixtures --zec-mint-authority <pubkey>
//       → fixtures/zec-mint.json : the bridged ZEC mint with its mint authority replaced by a local test key,
//         so tests can mint collateral. On mainnet the authority is the bridge program's PDA.
//
// Layouts are the ones docs/VERIFIED-SOLANA-FACTS.md records (OraclePrices: disc 8 | mappings 32 | 512 × 56;
// DatedPrice: value u64 | exp u64 | last_updated_slot u64 | unix_timestamp u64 | generic 24; SPL Mint: 82 bytes,
// COption<Pubkey> mint_authority at 0..36, supply u64 at 36, decimals u8 at 44, is_initialized at 45,
// COption<Pubkey> freeze_authority at 46..82).
import { mkdirSync, writeFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const outDir = opt("--out", "fixtures");
mkdirSync(outDir, { recursive: true });

const SCOPE_PRICES = "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH";
const ZEC_MINT = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
const ENTRIES = [430, 429, 13, 456];
const FAR_FUTURE_TS = 4_102_444_800n; // 2100-01-01T00:00:00Z — beyond any test's wall clock

async function raw(method, params) {
  const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function fetchAccount(address) {
  const a = await raw("getAccountInfo", [address, { encoding: "base64", commitment: "finalized" }]);
  if (!a?.value) throw new Error(`${address}: no account`);
  return { data: Buffer.from(a.value.data[0], "base64"), lamports: a.value.lamports, owner: a.value.owner, executable: a.value.executable, rentEpoch: a.value.rentEpoch, space: a.value.space };
}
function writeFixture(file, address, acct, data) {
  const json = { pubkey: address, account: { lamports: acct.lamports, data: [data.toString("base64"), "base64"], owner: acct.owner, executable: acct.executable, rentEpoch: acct.rentEpoch, space: data.length } };
  writeFileSync(file, JSON.stringify(json, null, 2));
  console.log(`wrote ${file} (${address}, ${data.length} bytes)`);
}

if (flag("--future-timestamps")) {
  const acct = await fetchAccount(SCOPE_PRICES);
  const b = Buffer.from(acct.data);
  const n = (b.length - 40) / 56;
  if (!Number.isInteger(n)) throw new Error(`unexpected OraclePrices length ${b.length}`);
  const zecPrice = opt("--zec-price", null);
  for (const i of ENTRIES) {
    const o = 40 + i * 56;
    if (zecPrice && (i === 430 || i === 429)) {
      const value = BigInt(Math.round(Number(zecPrice) * 1e8));
      b.writeBigUInt64LE(value, o);
      b.writeBigUInt64LE(8n, o + 8);
    }
    b.writeBigUInt64LE(0n, o + 16); // last_updated_slot
    b.writeBigUInt64LE(FAR_FUTURE_TS, o + 24); // unix_timestamp
  }
  writeFixture(`${outDir}/scope-oracle-prices.json`, SCOPE_PRICES, acct, b);
  console.log(`entries ${ENTRIES.join(", ")} stamped ts=${FAR_FUTURE_TS}${zecPrice ? `, ZEC price set to $${zecPrice}` : ""}`);
}

const auth = opt("--zec-mint-authority", null);
if (auth) {
  const pk = new PublicKey(auth); // validates base58 / 32 bytes
  const acct = await fetchAccount(ZEC_MINT);
  const b = Buffer.from(acct.data);
  if (b.length !== 82) throw new Error(`unexpected mint length ${b.length}`);
  b.writeUInt32LE(1, 0); // COption::Some
  pk.toBuffer().copy(b, 4);
  writeFixture(`${outDir}/zec-mint.json`, ZEC_MINT, acct, b);
  console.log(`mint authority set to ${auth} (local test key; mainnet authority is the bridge PDA)`);
}

if (!flag("--future-timestamps") && !auth) {
  console.error("nothing to do: pass --future-timestamps and/or --zec-mint-authority <pubkey>");
  process.exit(2);
}
