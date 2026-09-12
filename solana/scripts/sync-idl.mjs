// Copies the built IDLs (target/idl, gitignored) into solana/idl (committed) — the Solana twin of
// contracts/abi/oilskin-abi.json. The keeper's hand-written encoders are pinned to solana/idl/oilskin.json by
// agent/scripts/verify-solana-idl.mjs, so a signature change here must be deliberate and reviewed.
//
//   node solana/scripts/sync-idl.mjs           → writes solana/idl/*.json
//   node solana/scripts/sync-idl.mjs --check   → exit 1 if a committed IDL differs from the build
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, "..", "target", "idl");
const dest = join(here, "..", "idl");
const check = process.argv.includes("--check");
let drift = 0;
for (const name of ["oilskin", "mock_scope"]) {
  const src = join(built, `${name}.json`);
  if (!existsSync(src)) {
    console.error(`${src} missing — run: anchor build`);
    process.exit(1);
  }
  const idl = JSON.parse(readFileSync(src, "utf8"));
  const out = JSON.stringify(idl, null, 2) + "\n";
  const target = join(dest, `${name}.json`);
  if (check) {
    const cur = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (cur !== out) {
      console.error(`DRIFT: ${target} differs from the build (${idl.instructions?.length ?? 0} instructions in the build)`);
      drift++;
    } else console.log(`${name}: committed IDL matches the build (${idl.instructions.length} instructions, ${idl.accounts?.length ?? 0} accounts)`);
  } else {
    writeFileSync(target, out);
    console.log(`wrote ${target} (${idl.instructions.length} instructions, ${idl.accounts?.length ?? 0} accounts, address ${idl.address})`);
  }
}
process.exit(drift ? 1 : 0);
