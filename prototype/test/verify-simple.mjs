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

const errs = [];
const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", m => { if (m.type() === "error" && !/127\.0\.0\.1:8787|ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text()); });
page.on("pageerror", e => errs.push("PAGEERROR: " + e.message));
await page.goto(PAGE_URL("simple.html"));
await page.waitForTimeout(600);

const T = [];
const ok = (name, cond, extra="") => T.push([cond?"PASS":"FAIL", name, extra]);

// boot state
const boot = await page.evaluate(() => {
  const o = window.__oil;
  return { selPool:o.selPool, apy:document.querySelector("#apyHero").textContent,
    note:document.querySelector("#marketNote").style.display,
    poolCards:[...document.querySelectorAll("#poolSeg .poolb")].map(b=>({id:b.dataset.pool,ok:b.dataset.ok,dis:b.disabled,on:b.classList.contains("on")})),
    lendQ:o.qualifies(o.poolById("lend"),"sheltered"),
    q:{acb:o.qualifies(o.poolById("acbbtc"),"sheltered"), aw:o.qualifies(o.poolById("aweth"),"working"), wb:o.qualifies(o.poolById("wbtc"),"steady")} };
});
ok("boot: lend selected (no LP qualifies)", boot.selPool==="lend", boot.selPool);
ok("boot: headline is supply rate 0.04%", /0\.04%/.test(boot.apy), boot.apy);
ok("boot: market note visible", boot.note==="block");
ok("boot: all LP cards disqualified+disabled", boot.poolCards.filter(c=>c.id!=="lend").every(c=>c.ok==="false"&&c.dis));
ok("boot: lend card enabled+selected", boot.poolCards.find(c=>c.id==="lend").on===true);
ok("model: nothing qualifies at sample rates", !boot.q.acb && !boot.q.aw && !boot.q.wb);

// risk settings cycle
for (const l of [40,50,30]) await page.click(`#riskSeg [data-ltv="${l}"]`);
const hint = await page.evaluate(()=>document.querySelector("#riskHint").textContent);
ok("risk hint mentions lending-only default", /Lending only/.test(hint), hint.slice(0,80));

// what-if flips the gate
const wi = await page.evaluate(() => {
  const o = window.__oil;
  o.setWhatIf(4, 4);
  return { q:o.qualifies(o.poolById("acbbtc"),"sheltered"), sel:o.selPool, un:o.userNet(o.poolById("acbbtc"),"sheltered"),
    tag:document.querySelector("#whatif").classList.contains("on"), apy:document.querySelector("#apyHero").textContent };
});
ok("what-if AERO×4+borrow4: cbBTC/USDC qualifies", wi.q);
ok("what-if: auto-selected best pool", wi.sel!=="lend", wi.sel);
ok("what-if: tag shown", wi.tag);
ok("what-if: userNet positive", wi.un>0, wi.un.toFixed(2));

// deposit flow under what-if
await page.fill("#homeAddr", "t1TEsT2aZxCvBnM4qWeRtY7uIoP9sDfG1hK");
await page.fill("#amt", "20");
const gateOk = await page.evaluate(()=>!document.querySelector("#startBtn").disabled);
ok("gate opens with valid addr+amt", gateOk);
await page.click("#startBtn");
await page.click("#sentBtn");
await page.waitForSelector("#depDone", { state: "visible", timeout: 15000 });
await page.click("#depDone");
await page.waitForTimeout(300);
const dash = await page.evaluate(() => {
  const o = window.__oil;
  return { active:o.pos.active, kind:o.pos.kind, zec:o.pos.zec, debt:o.pos.debtUsd, lp:o.pos.lpUsd,
    total:document.querySelector("#stTotal").textContent, hfChip:document.querySelector("#hfChip").textContent,
    posCards:document.querySelectorAll("#posList .pos").length, acts:o.activity.length,
    homeShort:document.querySelector("#homeShort").textContent };
});
ok("deposit → active LP position", dash.active && dash.kind==="LP" && dash.zec===20);
ok("debt = 20×px×30%", Math.abs(dash.debt - 20*487.2*0.3) < 20*487.2*0.3*0.02, String(dash.debt));
ok("dashboard renders", dash.posCards===1 && /\$/.test(dash.total) && /HF/.test(dash.hfChip));
ok("activity logged", dash.acts>=1);

// persistence: reload
await page.reload(); await page.waitForTimeout(600);
const re = await page.evaluate(()=>({active:window.__oil.pos.active, zec:window.__oil.pos.zec, acts:window.__oil.activity.length, shown:document.querySelector("#posWrap").style.display}));
ok("reload restores position", re.active && re.zec===20 && re.shown!=="none", JSON.stringify(re));

// what-if is NOT persisted (defaults after reload) → position card shows not-offered advisory
const adv = await page.evaluate(()=>{ const o=window.__oil; return {wiAero:o.WHATIF.aero, wiB:o.WHATIF.borrow, advisory:document.querySelector("#posList").textContent.includes("no longer clears")} });
ok("what-if resets on reload", adv.wiAero===1 && adv.wiB===null);
ok("position card carries not-offered advisory at real rates", adv.advisory);

// simulations
const sims = await page.evaluate(async () => {
  const o = window.__oil, out = {};
  out.partial = o.simulate("partialFill"); out.idle = o.pos.idleUsd;
  out.range = o.simulate("outOfRange"); out.rangeState = o.pos.range;
  o.simulate("crash"); out.hfAfterCrash = o.hf(); out.ladder = o.pos.ladder; out.warned = o.pos.warned;
  o.simulate("crash2"); out.ladder2 = o.pos.ladder; out.lpAfter = o.pos.lpUsd; out.hfAfter2 = o.hf();
  o.simulate("recover");
  return out;
});
ok("partialFill books idle", sims.idle>0, String(sims.idle));
ok("outOfRange flips range", sims.rangeState==="out");
ok("crash −40%: buffer holds at Sheltered (warn only, no unwind)", sims.ladder===0 && sims.warned===true && sims.hfAfterCrash>1.35, "hf="+sims.hfAfterCrash.toFixed(2)+" ladder="+sims.ladder);
ok("crash2 −65%: ladder de-risks and restores HF ≥ 1.05", sims.ladder2>=2 && sims.hfAfter2>=1.05, "ladder="+sims.ladder2+" hf2="+(sims.hfAfter2||0).toFixed(2));

// withdraw full → hero returns, find-my-position works
await page.evaluate(()=>window.__oil.withdraw(100));
await page.waitForTimeout(200);
const after = await page.evaluate(()=>({active:window.__oil.pos.active, hero:document.querySelector("#hero").style.display}));
ok("full withdraw → hero", !after.active && after.hero!=="none");
const find = await page.evaluate(()=>{ const o=window.__oil; const bad=o.find("t1TEsT2aZxCvBnM4qWeRtY7uIoP9sDfG1hK"); const ex=o.find(o.EXAMPLE_ADDR); return {bad:bad.ok, ex:ex.ok, pos:o.pos.active, pool:o.pos.pool}; });
ok("find: unknown addr → not found", find.bad===false);
ok("find: example addr restores example", find.ex===true && find.pos && find.pool==="acbbtc");

// example position numbers are honest (slightly negative P&L)
const exNums = await page.evaluate(()=>{ const o=window.__oil; return {nv:o.netValue(), coll:o.pos.zec*o.S.zec, claim:o.pos.claimUsd, idle:o.pos.idleUsd}; });
ok("example: net value < collateral (underwater LP is shown)", exNums.nv < exNums.coll, (exNums.nv-exNums.coll).toFixed(2));
ok("example: claimable + idle > 0", exNums.claim>0 && exNums.idle>0);

// docs model table + emissions language
const docs = await page.evaluate(()=>{
  const t=document.querySelector("#modelTable").textContent;
  const body=document.body.textContent;
  return { rows:document.querySelectorAll("#modelTable tr").length, notOffered:(t.match(/not offered/g)||[]).length,
    tradingFeeYield:/fees sampled/i.test(body), feesAsYield:/Fees sampled|fee APR/i.test(body) };
});
ok("model table renders 9 pool rows", docs.rows===10, String(docs.rows));
ok("model table: all 9 not offered", docs.notOffered===9, String(docs.notOffered));
ok("no 'fees sampled' language anywhere", !docs.tradingFeeYield);

// forget device
await page.evaluate(()=>{document.querySelector("#forgetBtn").click()});
const forgot = await page.evaluate(()=>({active:window.__oil.pos.active, saved:localStorage.getItem(window.__oil.KEY)}));
ok("forget clears position+storage", !forgot.active && !forgot.saved);

// mobile quick pass
await page.setViewportSize({ width: 390, height: 800 });
await page.waitForTimeout(300);
const hscroll = await page.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok("mobile: no horizontal scroll", hscroll<=1, String(hscroll));

console.log(T.map(t=>t.join("  ")).join("\n"));
const fails = T.filter(t=>t[0]==="FAIL").length;
console.log(`\n${T.length-fails}/${T.length} passed; console errors: ${errs.length}`);
errs.slice(0,6).forEach(e=>console.log("ERR:", e.slice(0,200)));
await browser.close();
process.exit(fails||errs.length?1:0);
