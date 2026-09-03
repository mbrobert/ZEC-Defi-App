/* Portable Playwright loader: uses the workspace's playwright if installed,
   else a global one; CHROMIUM_PATH overrides the browser binary. Run from
   anywhere: node prototype/test/<file>.mjs */
import { fileURLToPath } from "url";
let chromium;
try { ({ chromium } = await import("playwright")); }
catch {
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  ({ chromium } = require("/home/claude/.npm-global/lib/node_modules/playwright"));
}
const LAUNCH = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const PAGE_URL = (f) => "file://" + fileURLToPath(new URL("../" + f, import.meta.url));
const browser = await chromium.launch(LAUNCH);
const errors = [];
const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
page.on("console", m => { if (m.type() === "error" && !/ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(m.text()); });
page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
await page.goto(PAGE_URL("index.html"));
await page.waitForTimeout(600);
const t = async (name, fn) => { try { await fn(); console.log("PASS", name); } catch (e) { console.log("FAIL", name, "—", e.message.split("\n")[0]); } };

await t("nav: Oilskin mark present, no 'ZEC Yield Orchestrator' anywhere", async () => {
  if (!(await page.locator("#homeBtn svg use[href='#mark']").count())) throw new Error("no mark");
  const body = await page.evaluate(() => document.body.innerText);
  if (/ZEC Yield Orchestrator/.test(body)) throw new Error("old product name still present");
});
await t("logo click returns to dashboard from any tab", async () => {
  await page.click('.tab[data-view="pools"]');
  await page.waitForTimeout(150);
  await page.click("#homeBtn");
  await page.waitForTimeout(150);
  if (!(await page.locator("#view-dash.on").count())) throw new Error("not on dashboard");
});
await t("claimable = AERO incentives only (335 → −15% → −10% → $256)", async () => {
  await page.click("#posList > *:first-child .pos-head");
  await page.waitForTimeout(200);
  const s = await page.evaluate(() => document.querySelector("#posList > *:first-child").innerText);
  if (!/AERO incentives \(staked in gauge\)/.test(s)) throw new Error("no incentives row");
  if (/LP trading fees\s*\$/.test(s)) throw new Error("trading fees still advertised as claimable");
  if (!/\$256/.test(s)) throw new Error("net claimable wrong: " + s.match(/Net claimable[^\n]*/));
  if (!/veAERO voters/.test(s)) throw new Error("no fee-forfeit explanation");
});
await t("dashboard claimable tile matches incentives-only sum ($298)", async () => {
  const v = await page.textContent("#stClaim");
  if (!/\$298/.test(v)) throw new Error(v);
});
await t("pools view: 8 Aerodrome rows, dynamic fee labels, no Uniswap", async () => {
  await page.click('.tab[data-view="pools"]');
  await page.waitForTimeout(250);
  const rows = await page.locator("#poolTable tbody tr").count();
  if (rows !== 8) throw new Error("rows: " + rows);
  const txt = await page.textContent("#poolTable");
  if (/Uniswap/.test(txt)) throw new Error("Uniswap still offered");
  if (!/today/.test(txt)) throw new Error("no dynamic-fee labels");
  for (const eid of ["0x0ea7…72a8","0xb183…37e6","0xc97c…c35f","0x477c…ab24","0xcfde…d419","0x0ff8…abd7","0x6d94…c1d1","0xa893…9bfc"]) {
    if (!txt.includes(eid)) throw new Error("missing eid " + eid);
  }
});
await t("wizard: emissions+IL model — USDC borrow negative at defaults, WETH borrow strictly higher", async () => {
  await page.click("#homeBtn");
  await page.click('.tab[data-view="wiz"]');
  await page.waitForTimeout(200);
  await page.click('.opt[data-mode="FULL"]');
  await page.click("#nextBtn");
  await page.waitForTimeout(300);
  const num = s => parseFloat(String(s).replace("−","-").replace("%",""));
  const a1 = num(await page.textContent("#pApy"));
  if (!(a1 < 0)) throw new Error("USDC est should be negative at 2026-08-31 rates: " + a1);
  await page.click('#assetSeg [data-asset="WETH"]');
  await page.waitForTimeout(250);
  const a2 = num(await page.textContent("#pApy"));
  if (!(a2 > a1)) throw new Error(`WETH borrow (0.49%) must beat USDC (13.47%): ${a1} vs ${a2}`);
  const model = await page.evaluate(() => { // model internals: emissions curve + calibrated drag
    const p = POOLS.find(x=>x.id==="aero-usdc-weth-5");
    const f = w => 2 - Math.sqrt(1-w) - 1/Math.sqrt(1+w);
    return { e25: p.ek/f(0.25), e15: p.ek/f(0.015), inactive: POOLS.find(x=>x.id==="aero-aero-weth").epoch===false };
  });
  if (Math.abs(model.e25 - 7.69) > 0.1 || Math.abs(model.e15 - 123.3) > 1) throw new Error("emissions curve off: " + JSON.stringify(model));
  if (!model.inactive) throw new Error("AERO/WETH gauge should be flagged inactive");
  await page.click('#assetSeg [data-asset="USDC"]');
});
await t("MAX button explains demo balance, not a cap — and still fills 450", async () => {
  // the tooltip system migrates title → data-tip at bind time
  const tip = await page.getAttribute("#maxBtn", "data-tip");
  if (!/NOT a protocol cap/i.test(tip) || !/no deposit limit/i.test(tip)) throw new Error(String(tip));
  await page.click("#backBtn"); // wizard is on step 2 after the borrow-asset test; MAX lives on step 1
  await page.waitForTimeout(150);
  await page.click("#maxBtn");
  await page.waitForTimeout(120);
  const v = await page.inputValue("#amt");
  if (v !== "450") throw new Error("MAX filled " + v);
  await page.fill("#amt", "100");
});
await t("mode chips render whole (nowrap) on narrow cards", async () => {
  const ok = await page.evaluate(() => {
    const chip = [...document.querySelectorAll('.opt[data-mode="FULL"] .chip')][0];
    if (!chip) return "no chip";
    const r = chip.getBoundingClientRect();
    return r.height < 30 ? true : "chip wrapped internally, h=" + r.height;
  });
  if (ok !== true) throw new Error(String(ok));
});
await t("deposit stepper carries the on-chain-confirmation note", async () => {
  const s = await page.evaluate(() => document.querySelector("#goOverlay").innerText);
  if (!/confirmed on-chain/.test(s) || !/never on a timer/.test(s)) throw new Error("note missing");
});
await t("footer: disclaimer + BUILT ON rail with 5 links", async () => {
  const foot = await page.evaluate(() => document.querySelector("footer").innerText);
  if (!/accepts no responsibility/.test(foot) || !/afford to lose/.test(foot)) throw new Error("no disclaimer");
  for (const href of ["https://www.rhea.finance/","https://intents.near.org/","https://base.org","https://aerodrome.finance","https://www.snuggle.fi/"]) {
    if (!(await page.locator(`a[href="${href}"]`).count())) throw new Error("missing " + href);
  }
});
await t("docs: staked-rewards model + live sampled supply rate", async () => {
  const s = await page.evaluate(() => [...document.querySelectorAll(".doc-sec")].map(x => x.innerText).join("\n"));
  if (!/staked in its pool's Aerodrome gauge/.test(s)) throw new Error("no staked doc");
  if (!/AERO incentives/.test(s)) throw new Error("no AERO doc");
  if (/LP earnings only, at harvest/.test(s)) throw new Error("stale engine-fee row");
});
await t("internally consistent account: HF 1.90, LTV 36.7%, ZEC $487.20", async () => {
  await page.click("#homeBtn"); // innerText only sees the visible view — go back to the dashboard
  await page.waitForTimeout(200);
  const s = await page.evaluate(() => document.body.innerText);
  if (!/\$4[89]\d\.\d\d/.test(s)) throw new Error("price not in the ~$487 demo range (live jitter wiggles it)");
  if (!/36\.[0-9]% LTV/.test(s)) throw new Error("LTV (live jitter wiggles the decimals)");
  const hf = await page.textContent("#hfVal");
  if (!/1\.9/.test(hf)) throw new Error("HF " + hf);
});
console.log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "ZERO CONSOLE ERRORS");
await browser.close();
