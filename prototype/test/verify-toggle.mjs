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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", e => errors.push("SIMPLE: " + e.message));
page.on("console", m => { if (m.type() === "error" && !/ERR_CONNECTION_REFUSED/.test(m.text())) errors.push("SIMPLE-C: " + m.text()); });
await page.goto(PAGE_URL("simple.html"));
await page.waitForTimeout(400);
const href = await page.getAttribute("#modeTog", "href");
console.log(href === "index.html" ? "PASS simple toggle href" : "FAIL simple toggle " + href);
await page.click("#modeTog");
await page.waitForTimeout(900);
const url = page.url();
console.log(/index\.html$/.test(url) ? "PASS toggle navigates to advanced" : "FAIL nav " + url);
const logo = await page.textContent(".logo");
console.log(/Oilskin/.test(logo) && /Advanced/.test(logo) ? "PASS advanced logo rebranded" : "FAIL logo: " + logo);
const back = await page.locator('a[href="simple.html"]').count();
console.log(back >= 1 ? "PASS advanced has Simple link" : "FAIL no back link");
await page.click('a[href="simple.html"]');
await page.waitForTimeout(700);
console.log(/simple\.html$/.test(page.url()) ? "PASS round trip" : "FAIL round trip " + page.url());
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const mob = await mctx.newPage();
mob.on("pageerror", e => errors.push("MOB: " + e.message));
await mob.goto(PAGE_URL("simple.html"));
await mob.waitForTimeout(400);
const over = await mob.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log(over <= 4 ? "PASS mobile no overflow (toggle added)" : "FAIL overflow " + over);
await mob.screenshot({ path: "/tmp/shots3/s12-mobile-toggle.png" });
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "ZERO CONSOLE ERRORS (both)");
await browser.close();
