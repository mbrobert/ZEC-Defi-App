#!/usr/bin/env node
/**
 * feed-cadence — read a Chainlink aggregator proxy's OWN published history and report the cadence
 * it actually keeps. Read-only: one `latestRoundData` and N batched `getRoundData` calls, nothing
 * else, no key, no signing.
 *
 *   node scripts/feed-cadence.mjs 0x69e5BC4988a9AF30Ec827C5609c0D41028446ec0 1000
 *   RPC_URL=https://mainnet.base.org node scripts/feed-cadence.mjs <proxy> [rounds]
 *
 * Why this exists. A Chainlink feed publishes on TWO triggers — a deviation threshold and a
 * heartbeat — and only the heartbeat is a liveness bound. Neither is exposed by a getter, and
 * neither may be typed from memory (CLAUDE.md rule 3). A short sample taken while the market is
 * moving contains only deviation-driven gaps, so it measures volatility, not cadence: that was
 * finding FEED-MED-1, and it is why the keeper's probe is now a window of time rather than a count
 * of rounds. Run this before choosing any `maxAge`, including the immutable constructor parameter
 * of `ChainlinkOracleAdapter`.
 *
 * What it prints: the gap distribution; the largest gaps with the price move that ended each one
 * (a gap ending on a near-zero move is a HEARTBEAT publication; one ending on a threshold-sized
 * move is deviation-driven); and a replay of the keeper's own staleness rule over the history, so
 * the bound it would derive at every possible start-up point can be seen rather than assumed.
 *
 * A feed with no near-zero-move gap anywhere in the sample has not shown its heartbeat at all: its
 * largest gap is a LOWER BOUND on the heartbeat, never an estimate of it. The script says so.
 */
const PROXY = process.argv[2];
const WANT = Number(process.argv[3] ?? 600);
const RPC = process.env.RPC_URL ?? "https://mainnet.base.org";
const SLACK = Number(process.env.FEED_HEARTBEAT_SLACK ?? 2);
const MIN_MAX_AGE = Number(process.env.FEED_MIN_MAX_AGE_S ?? 300);
const WINDOW_S = Number(process.env.FEED_HEARTBEAT_WINDOW_S ?? 24 * 3600);
const CAP = Number(process.env.FEED_HEARTBEAT_ROUNDS ?? 120);
// Batch size. Public endpoints cap this and say so: `https://mainnet.base.org` allows 10 per
// batch (error -32014), publicnode allows far more. The loop below halves on a batch-level
// error rather than assuming any one host's limit.
let BATCH = Number(process.env.BATCH ?? 10);
/** A move under this is too small to have tripped a deviation threshold: a heartbeat publication. */
const QUIET_PCT = Number(process.env.QUIET_PCT ?? 0.2);

if (!PROXY || !/^0x[0-9a-fA-F]{40}$/.test(PROXY)) {
  console.error("usage: node scripts/feed-cadence.mjs <proxy address> [rounds]");
  process.exit(1);
}

const SEL_LATEST = "0xfeaf968c"; // latestRoundData()
const SEL_ROUND = "0x9a6fc8f5"; // getRoundData(uint80)
const SEL_DECIMALS = "0x313ce567";

async function rpc(payload) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${RPC} HTTP ${res.status}`);
  return res.json();
}

function decodeRound(hex) {
  const h = hex.slice(2);
  const w = (i) => BigInt("0x" + h.slice(i * 64, (i + 1) * 64));
  let answer = w(1);
  if (answer >= 1n << 255n) answer -= 1n << 256n;
  return { roundId: w(0), answer, updatedAt: w(3), answeredInRound: w(4) };
}

const one = async (data) => {
  const [r] = await rpc([{ jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: PROXY, data }, "latest"] }]);
  if (r.error) throw new Error(r.error.message);
  return r.result;
};

const decimals = Number(BigInt(await one(SEL_DECIMALS)));
const latest = decodeRound(await one(SEL_LATEST));
const phase = latest.roundId >> 64n;
const lastN = latest.roundId & ((1n << 64n) - 1n);
const first = lastN > BigInt(WANT) ? lastN - BigInt(WANT) + 1n : 1n;

const rounds = new Map();
let pending = [];
for (let n = first; n <= lastN; n++) pending.push(n);

/**
 * Read every round, retrying what fails. Two distinct failures happen on public endpoints and
 * they need different answers:
 *  - a BATCH-level error (one object, not an array) is a size cap — `https://mainnet.base.org`
 *    answers -32014 "maximum 10 calls in 1 batch". Halve and re-ask the same rounds.
 *  - a PER-ITEM error inside an otherwise fine array is a burst rate limit: the first few calls
 *    answer and the rest come back `over rate limit`. Those rounds must be RE-ASKED, never
 *    dropped — a dropped round turns two real gaps into one fictitious long one, which is
 *    exactly the kind of invented number rule 3 forbids.
 */
let pace = Number(process.env.PACE_MS ?? 350);
for (let pass = 1; pass <= 8 && pending.length; pass++) {
  const failed = [];
  let itemErrors = 0;
  let lastItemError = null;
  let cursor = 0;
  while (cursor < pending.length) {
    const chunk = pending.slice(cursor, cursor + BATCH);
    const payload = chunk.map((n, j) => ({
      jsonrpc: "2.0",
      id: j,
      method: "eth_call",
      params: [{ to: PROXY, data: SEL_ROUND + ((phase << 64n) | n).toString(16).padStart(64, "0") }, "latest"],
    }));
    let res = null;
    let err = null;
    try {
      res = await rpc(payload);
    } catch (e) {
      err = e.message;
    }
    if (err || !Array.isArray(res)) {
      if (BATCH > 1) {
        BATCH = Math.max(1, Math.floor(BATCH / 2));
        console.error(`  batch rejected (${err ?? JSON.stringify(res?.error ?? res).slice(0, 90)}) — retrying at ${BATCH} per batch`);
        await new Promise((r) => setTimeout(r, 500));
        continue; // cursor unmoved: the same rounds are re-asked
      }
      failed.push(...chunk);
      cursor += chunk.length;
      await new Promise((r) => setTimeout(r, pace));
      continue;
    }
    const byId = new Map(res.filter((x) => x && typeof x.id === "number").map((x) => [x.id, x]));
    for (let j = 0; j < chunk.length; j++) {
      const x = byId.get(j);
      if (x?.result && x.result.length >= 2 + 5 * 64) {
        rounds.set(chunk[j], decodeRound(x.result));
      } else {
        failed.push(chunk[j]);
        itemErrors++;
        lastItemError = x?.error?.message ?? "no result";
      }
    }
    cursor += chunk.length;
    await new Promise((r) => setTimeout(r, pace));
  }
  if (failed.length) {
    console.error(
      `  pass ${pass}: ${rounds.size}/${lastN - first + 1n} rounds read, ${failed.length} to retry` +
        (itemErrors ? ` (${itemErrors} per-item: ${lastItemError})` : "")
    );
    pace = Math.min(4000, Math.round(pace * 2)); // back off: these are burst limits
    await new Promise((r) => setTimeout(r, 2000));
  }
  pending = failed;
}
if (pending.length) {
  console.error(`${pending.length} round(s) still unreadable after 8 passes — try another RPC_URL, or a smaller range.`);
}

const ns = [...rounds.keys()].sort((a, b) => (a < b ? -1 : 1));
if (ns.length < 3) {
  console.error(`only ${ns.length} round(s) readable — nothing to measure`);
  process.exit(1);
}
// A hole makes every "gap" spanning it a fiction — two rounds an hour apart with a missed round
// between them read as one long quiet stretch. Refuse rather than report a number that is wrong.
const holes = [];
for (let i = 1; i < ns.length; i++) if (ns[i] - ns[i - 1] !== 1n) holes.push(`${ns[i - 1]}→${ns[i]}`);
if (holes.length) {
  console.error(
    `${holes.length} hole(s) in the sample (${holes.slice(0, 5).join(", ")}${holes.length > 5 ? ", …" : ""}). ` +
      "Gaps across a missing round are not real gaps, so no distribution is printed. Re-run (a smaller BATCH, " +
      "or another RPC_URL) until the rounds read are contiguous."
  );
  process.exit(1);
}
const scale = 10 ** decimals;
const ts = ns.map((n) => Number(rounds.get(n).updatedAt));
const px = ns.map((n) => Number(rounds.get(n).answer) / scale);
const gaps = ts.slice(1).map((t, i) => t - ts[i]);
const devs = px.slice(1).map((p, i) => Math.abs(p / px[i] - 1) * 100);
const sorted = [...gaps].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))];
const iso = (t) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

console.log(`\n${PROXY}  phase ${phase}  decimals ${decimals}`);
console.log(`${ns.length} rounds (${ns[0]}–${ns[ns.length - 1]}), ${iso(ts[0])} → ${iso(ts[ts.length - 1])}, ${((ts[ts.length - 1] - ts[0]) / 86400).toFixed(2)} days`);
console.log(`price ${px[0].toLocaleString()} → ${px[px.length - 1].toLocaleString()}`);
console.log(`\ngaps between publications (s): min ${sorted[0]}  median ${pct(50)}  p90 ${pct(90)}  p99 ${pct(99)}  MAX ${sorted[sorted.length - 1]} (${(sorted[sorted.length - 1] / 3600).toFixed(2)} h)`);

const order = gaps.map((g, i) => i).sort((a, b) => gaps[b] - gaps[a]);
console.log(`\nthe 10 longest gaps, and the price move that ENDED each:`);
for (const i of order.slice(0, 10)) {
  const move = (px[i + 1] / px[i] - 1) * 100;
  const kind = Math.abs(move) < QUIET_PCT ? "HEARTBEAT" : "deviation";
  console.log(`  ${String(gaps[i]).padStart(7)} s (${(gaps[i] / 3600).toFixed(2)} h)  round ${ns[i]}→${ns[i + 1]}  ends ${iso(ts[i + 1])}  ${move >= 0 ? "+" : ""}${move.toFixed(3)} %  ${kind}`);
}

const quiet = order.filter((i) => Math.abs(devs[i]) < QUIET_PCT);
const minDev = Math.min(...devs);
console.log(`\nsmallest move between consecutive answers: ${minDev.toFixed(4)} %  |  publications under ${QUIET_PCT} %: ${quiet.length} of ${devs.length}`);
if (quiet.length === 0) {
  console.log(
    `\n*** NO HEARTBEAT PUBLICATION IN THIS SAMPLE. Every round moved at least ${minDev.toFixed(3)} %, so every\n` +
      `    one was deviation-driven. The heartbeat is therefore LONGER than the largest gap seen\n` +
      `    (${sorted[sorted.length - 1]} s) and cannot be measured from this history. Do not derive a maxAge from it:\n` +
      `    take Chainlink's published heartbeat, or sample a longer window, or choose the bound deliberately. ***`
  );
} else {
  const hb = Math.max(...quiet.map((i) => gaps[i]));
  console.log(`heartbeat, from the longest gap that ended on a near-zero move: ~${hb} s (${(hb / 3600).toFixed(2)} h)`);
}

// Replay the keeper's rule at every possible start-up point.
function replay(windowS, cap) {
  const bounds = [];
  const staleFrac = [];
  for (let i = 1; i < gaps.length; i++) {
    let lo = i;
    // `windowS === 0` is the pre-FEED-MED-1 behaviour: a flat count of rounds.
    while (lo > 0 && i - lo + 1 < cap && (windowS === 0 || ts[i] - ts[lo - 1] < windowS)) lo--;
    const win = gaps.slice(lo, i);
    if (!win.length) continue;
    const covered = ts[i] - ts[lo];
    const probed = Math.ceil(Math.max(...win) * SLACK);
    const short = covered < windowS;
    const bound = short ? Math.max(probed, Number(process.env.PRICE_MAX_AGE_S ?? 10800)) : Math.max(probed, MIN_MAX_AGE);
    let stale = 0;
    let total = 0;
    for (let j = i; j < gaps.length; j++) {
      total += gaps[j];
      stale += Math.max(0, gaps[j] - bound);
    }
    if (total) {
      bounds.push(bound);
      staleFrac.push(stale / total);
    }
  }
  const s = [...staleFrac].sort((a, b) => a - b);
  const b = [...bounds].sort((a, b2) => a - b2);
  return {
    medianBound: b[Math.floor(b.length / 2)],
    medianStale: s[Math.floor(s.length / 2)] * 100,
    p90Stale: s[Math.min(s.length - 1, Math.round(0.9 * (s.length - 1)))] * 100,
  };
}
console.log(`\nthe keeper's staleness rule replayed at every start-up point in this history`);
console.log(`(slack ×${SLACK}, floor ${MIN_MAX_AGE} s — "stale time" is the share of wall clock the feed would read STALE):`);
console.log(`| probe | bound derived (median) | stale time (median) | stale time (p90) |`);
console.log(`|---|---|---|---|`);
for (const [label, w, c] of [
  ["6 rounds, no window (before FEED-MED-1)", 0, 6],
  [`${WINDOW_S} s window, cap ${CAP} (as shipped)`, WINDOW_S, CAP],
]) {
  const r = replay(w, c);
  console.log(`| ${label} | ${r.medianBound} s | ${r.medianStale.toFixed(2)} % | ${r.p90Stale.toFixed(2)} % |`);
}
