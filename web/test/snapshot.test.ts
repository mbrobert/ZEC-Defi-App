import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AAVE_V3, BASE_TOKENS, CBZEC_ADDRESS, COW_PROTOCOL, PERMIT2 } from "@zyo/shared";
import { DEMO_ACCOUNT, DEMO_GATE_RAW, DEMO_MARKET, DEMO_OWNER, DEMO_SNAPSHOT_SOURCE } from "../lib/demo";
import { ENV } from "../lib/env";

const DOC = join(__dirname, "../../docs/VERIFIED-BASE-FACTS.md");

/**
 * The demo snapshot must be a faithful copy of docs/VERIFIED-BASE-FACTS.md —
 * it is the only place the web app carries chain numbers, and only for demo
 * mode. Parse the doc's Aave table and compare.
 */
test("DEMO_MARKET equals the VERIFIED-BASE-FACTS Aave table", () => {
  assert.equal(DEMO_SNAPSHOT_SOURCE, "docs/VERIFIED-BASE-FACTS.md");
  const doc = readFileSync(DOC, "utf8");
  const row = (name: string) => {
    // Cells may be **bold** or plain; strip emphasis before matching.
    const plain = doc.replace(/\*\*/g, "");
    const m = plain.match(new RegExp(`^\\| ${name} \\| ([\\d.]+)% \\| ([\\d.]+)% \\| ([\\d.]+)% \\| yes \\| yes \\| ([\\d.]+)% \\| ([\\d.]+)% \\|`, "m"));
    assert.ok(m, `row for ${name} in VERIFIED-BASE-FACTS`);
    return { ltv: Math.round(Number(m![1]) * 100), lt: Math.round(Number(m![2]) * 100), bonus: Math.round(Number(m![3]) * 100), borrow: Number(m![4]), supply: Number(m![5]) };
  };
  for (const s of ["cbBTC", "WETH", "USDC"] as const) {
    const d = row(s);
    const r = DEMO_MARKET.reserves[s]!;
    assert.equal(r.ltvBps, d.ltv, `${s} ltv`);
    assert.equal(r.liquidationThresholdBps, d.lt, `${s} lt`);
    assert.equal(r.liquidationBonusBps, d.bonus, `${s} bonus`);
    assert.equal(r.variableBorrowAprPct, d.borrow, `${s} borrow`);
    assert.equal(r.supplyAprPct, d.supply, `${s} supply`);
  }
  assert.equal(DEMO_MARKET.usdcBorrowAprPct, row("USDC").borrow);
  assert.equal(DEMO_MARKET.reserves.cbZEC, null);
  assert.match(doc, /cbZEC \| — \| — \| — \| \*\*NOT LISTED\*\*/);
});

test("DEMO_MARKET prices equal the doc's Chainlink cbBTC/USD and ETH/USD answers", () => {
  const doc = readFileSync(DOC, "utf8");
  const price = (label: string) => Number(doc.match(new RegExp(`\\| ${label} \\| \`0x[0-9a-fA-F]+\` \\| ([\\d,.]+) \\|`))![1].replace(/,/g, ""));
  assert.equal(DEMO_MARKET.reserves.cbBTC!.priceUsd, price("cbBTC / USD"));
  assert.equal(DEMO_MARKET.reserves.WETH!.priceUsd, price("ETH / USD"));
});

test("every external address the web app uses is in VERIFIED-BASE-FACTS", () => {
  const doc = readFileSync(DOC, "utf8").toLowerCase();
  for (const [k, a] of Object.entries({
    cbZEC: CBZEC_ADDRESS,
    USDC: BASE_TOKENS.USDC.address,
    WETH: BASE_TOKENS.WETH.address,
    cbBTC: BASE_TOKENS.cbBTC.address,
    aavePool: AAVE_V3.pool,
    aaveDataProvider: AAVE_V3.poolDataProvider,
    aaveOracle: AAVE_V3.oracle,
    permit2: PERMIT2,
    cowSettlement: COW_PROTOCOL.settlement,
  })) {
    assert.ok(doc.includes(a.toLowerCase()), `${k} ${a} not in VERIFIED-BASE-FACTS`);
  }
});

test("demo addresses are obviously synthetic and never appear in VERIFIED-BASE-FACTS", () => {
  const doc = readFileSync(DOC, "utf8").toLowerCase();
  assert.ok(/^0x1{40}$/.test(DEMO_OWNER));
  assert.ok(/^0x2{40}$/.test(DEMO_ACCOUNT));
  assert.ok(!doc.includes(DEMO_OWNER));
});

test("contracts are unset by default (writes disabled until the contracts engineer deploys)", () => {
  assert.equal(ENV.oilskinFactory, "");
  assert.equal(ENV.oilskinRouter, "");
});

test("demo-gate.json is pinned to MODEL-NUMBERS.md (every served lpNet, drag, emissions and userNet cell)", (t) => {
  const p = "/tmp/build/MODEL-NUMBERS.md";
  if (!existsSync(p)) {
    t.skip("MODEL-NUMBERS.md not published yet");
    return;
  }
  const doc = readFileSync(p, "utf8");
  const borrow = doc.match(/USDC variable borrow APR: ([\d.]+)%/);
  assert.ok(borrow, "doc states the borrow rate");
  assert.equal(Number(borrow![1]), DEMO_GATE_RAW.borrowAprPct);
  assert.equal(DEMO_GATE_RAW.borrowAprPct, DEMO_MARKET.usdcBorrowAprPct);
  assert.match(doc, /No pool × setting clears the gate/);
  assert.equal(DEMO_GATE_RAW.qualifying.length, 0);

  // Per pool × setting table: | pool | setting | width | delay | gross | net | realized | drag | **lpNet** | ...
  const rows = [...doc.matchAll(/^\| (aero-[a-z0-9-]+|cbeth-weth) \| (sheltered|steady|working) \| (\d+) \([^)]*\) \| (\d+)h \| ([\d.]+)% \| ([\d.]+)% \| ([-\d.]+%|—) \| ([-\d.]+%|—) \| \*\*([-\d.]+)%\*\*|^\| (aero-[a-z0-9-]+|cbeth-weth) \| (sheltered|steady|working) \| (\d+) \([^)]*\) \| (\d+)h \| ([\d.]+)% \| ([\d.]+)% \| — \| — \| — /gm)];
  assert.ok(rows.length >= 20, `parsed ${rows.length} model rows`);
  let checked = 0;
  for (const m of rows) {
    const [poolId, setting, width, gross, net, realized, drag, lpNet] = m[1]
      ? [m[1], m[2], m[3], m[5], m[6], m[7], m[8], m[9]]
      : [m[10], m[11], m[12], m[14], m[15], "—", "—", null];
    const v = DEMO_GATE_RAW.verdicts.find((x) => x.poolId === poolId && x.setting === setting && x.collateral === "cbBTC");
    assert.ok(v, `${poolId}/${setting} in demo-gate.json`);
    assert.equal(v!.rangeWidthBps, Number(width), `${poolId}/${setting} width`);
    assert.equal(v!.emissionsGrossPct, Number(gross), `${poolId}/${setting} gross`);
    assert.equal(v!.emissionsNetPct, Number(net), `${poolId}/${setting} net`);
    if (lpNet !== null) {
      assert.equal(v!.lpNetPct, Number(lpNet), `${poolId}/${setting} lpNet`);
      assert.equal(v!.emissionsRealizedPct, Number(String(realized).replace("%", "")), `${poolId}/${setting} realized`);
      assert.equal(v!.dragPct, Number(String(drag).replace("%", "")), `${poolId}/${setting} drag`);
    }
    assert.equal(v!.qualifies, false);
    checked++;
  }
  assert.ok(checked >= 20, `${checked} cells pinned`);

  // User-net table: | pool | setting | collateral | LTV | lpNet | borrow | supply | **userNet** |
  const un = [...doc.matchAll(/^\| (aero-[a-z0-9-]+) \| (sheltered|steady|working) \| (cbBTC|WETH) \| (\d+)% \((p30|p40|top)\) \| [-\d.]+% \| [\d.]+% \| [\d.]+% \| \*\*([-\d.]+)%\*\* \|/gm)];
  assert.ok(un.length >= 50, `parsed ${un.length} user-net rows`);
  for (const m of un) {
    const v = DEMO_GATE_RAW.verdicts.find((x) => x.poolId === m[1] && x.setting === m[2] && x.collateral === m[3])!;
    const cell = v.userNet.find((u) => u.ltvBps === Number(m[4]) * 100)!;
    assert.equal(cell.userNetPct, Number(m[6]), `${m[1]}/${m[2]}/${m[3]}/${m[4]}% userNet`);
  }
});

test("demo-gate.json states the same liquidation thresholds and supply rates as the market snapshot", () => {
  assert.equal(DEMO_GATE_RAW.liquidationThresholdBps.cbBTC, DEMO_MARKET.reserves.cbBTC!.liquidationThresholdBps);
  assert.equal(DEMO_GATE_RAW.liquidationThresholdBps.WETH, DEMO_MARKET.reserves.WETH!.liquidationThresholdBps);
  const v = DEMO_GATE_RAW.verdicts.find((x) => x.collateral === "cbBTC" && x.collateralSupplyAprPct !== null)!;
  assert.equal(v.collateralSupplyAprPct, DEMO_MARKET.reserves.cbBTC!.supplyAprPct);
});
