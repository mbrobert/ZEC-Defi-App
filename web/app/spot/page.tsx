"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { usePublicClient, useWalletClient, useWriteContract } from "wagmi";
import { COW_PROTOCOL, classifyCbZecAddress, type B20ProbeVerdict } from "@zyo/shared";
import { probeB20Policy } from "@/lib/b20";
import { BASE_TOKENS, CBZEC_ADDRESS, CHAIN_ID } from "@/lib/chain";
import { useAccountRead, useMarket, useSession } from "@/lib/hooks";
import { useMode } from "@/lib/mode";
import { fromAtomic } from "@/lib/math";
import { ERC20_ABI } from "@/lib/abi/aave";
import { SPOT_TOKENS, getSpotQuote, makeTradingSdk, readAllowance, readOrderStatus, readVaultRelayer, type SpotOrderStatus, type SpotQuote, type SpotToken } from "@/lib/cow";
import { toAtomic } from "@/lib/math";
import { fmtAmount, fmtUsd } from "@/lib/format";
import { DEMO_CBZEC_PRICE_USDC } from "@/lib/demo";
import Chip from "@/components/Chip";
import Disclosures from "@/components/Disclosures";
import { TokenMark } from "@/components/TokenMark";

type Phase = "idle" | "quoting" | "quoted" | "approving" | "signing" | "posted" | "error";

import { COW_SUPPORTED, SLIPPAGE_MAX_BPS, SLIPPAGE_MIN_BPS, SLIPPAGE_WARN_BPS } from "@/lib/cow";

export default function SpotPage() {
  const s = useSession();
  const { mode, setMode } = useMode();
  const { market, source } = useMarket();
  const { account } = useAccountRead(market);
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  // Slice E (RISKS §4): before a user touches cbZEC here, read what the B20 precompile lets us see —
  // the live multiplier and whether a zero-amount transfer from THEIR address is refused right now.
  const [b20Probe, setB20Probe] = useState<B20ProbeVerdict | null>(null);
  const { data: walletClient } = useWalletClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();

  const [sell, setSell] = useState<SpotToken>("USDC");
  const [buy, setBuy] = useState<SpotToken>("cbZEC");
  const [amount, setAmount] = useState("100");
  const [phase, setPhase] = useState<Phase>("idle");
  const [quote, setQuote] = useState<SpotQuote | null>(null);
  const [post, setPost] = useState<null | (() => Promise<{ orderId: string }>)>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [status, setStatus] = useState<SpotOrderStatus | null>(null);
  const [relayer, setRelayer] = useState<Address | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slippageBps, setSlippageBps] = useState<number | null>(null); // null = CoW's suggestion

  const sdk = useMemo(() => (s.mode === "live" && publicClient && COW_SUPPORTED ? makeTradingSdk(publicClient, walletClient ?? undefined) : null), [s.mode, publicClient, walletClient]);

  // CoW Protocol settles on Base mainnet only: a rehearsal build says so instead of quoting nothing.
  useEffect(() => {
    if (!COW_SUPPORTED) setError(`Spot trading through CoW Protocol is available on Base mainnet only — this build is pointed at chain ${CHAIN_ID}.`);
  }, []);

  // Read the vault relayer (the spender) from settlement — never typed.
  useEffect(() => {
    if (s.mode !== "live" || !publicClient) return;
    let on = true;
    readVaultRelayer(publicClient).then((r) => on && setRelayer(r));
    return () => {
      on = false;
    };
  }, [s.mode, publicClient]);

  useEffect(() => {
    if (s.mode !== "live" || !publicClient || !relayer) return;
    let on = true;
    readAllowance(publicClient, sell, s.address, relayer)
      .then((a) => on && setAllowance(a))
      .catch(() => on && setAllowance(null));
    return () => {
      on = false;
    };
  }, [s.mode, publicClient, relayer, sell, s.address, phase]);

  // Poll order status after posting.
  useEffect(() => {
    if (!orderId || !sdk) return;
    let on = true;
    const tick = async () => {
      try {
        const r = await readOrderStatus(sdk, orderId);
        if (on) setStatus(r.status);
        if (on && (r.status === "fulfilled" || r.status === "cancelled" || r.status === "expired")) return;
      } catch {
        /* keep polling */
      }
      if (on) setTimeout(tick, 5_000);
    };
    tick();
    return () => {
      on = false;
    };
  }, [orderId, sdk]);

  const sellAtomic = useMemo(() => {
    try {
      return toAtomic(amount || "0", BASE_TOKENS[sell].decimals);
    } catch {
      return 0n;
    }
  }, [amount, sell]);

  // Demo quote: illustrative, from snapshot prices; the real quote comes from the CoW API.
  const demoQuote = useMemo(() => {
    if (s.mode !== "demo") return null;
    const px = (t: SpotToken) => (t === "USDC" ? 1 : t === "cbBTC" ? market.reserves.cbBTC?.priceUsd ?? NaN : t === "WETH" ? market.reserves.WETH?.priceUsd ?? NaN : DEMO_CBZEC_PRICE_USDC);
    const a = Number(amount) || 0;
    const out = (a * px(sell)) / px(buy);
    return { sell, buy, sellAmount: a, expectedBuy: out, minBuy: out * 0.995, networkCostSell: 0.4 / px(sell), slippageBps: 50, validForSeconds: 1800 };
  }, [s.mode, amount, sell, buy, market]);

  useEffect(() => {
    if (!(sell === "cbZEC" || buy === "cbZEC")) return;
    if (!publicClient || s.mode === "demo") {
      setB20Probe(null);
      return;
    }
    let cancelled = false;
    setB20Probe(null);
    probeB20Policy(publicClient as never, BASE_TOKENS.cbZEC.address, s.connected ? s.address : null)
      .then((v) => {
        if (!cancelled) setB20Probe(v);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sell, buy, publicClient, s.mode, s.connected, s.address]);

  async function getQuote() {
    setError(null);
    setPhase("quoting");
    try {
      if (!sdk) throw new Error("connect a wallet to fetch a CoW quote");
      const { quote: q, post: p } = await getSpotQuote(sdk, s.address, sell, buy, sellAtomic, slippageBps ?? undefined);
      setQuote(q);
      setPost(() => p);
      setPhase("quoted");
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  }

  async function approve() {
    if (!relayer) return;
    setPhase("approving");
    try {
      await writeContractAsync({ address: BASE_TOKENS[sell].address, abi: ERC20_ABI, functionName: "approve", args: [relayer, sellAtomic], chainId: CHAIN_ID });
      setPhase("quoted");
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  }

  async function sign() {
    if (!post) return;
    setPhase("signing");
    try {
      const r = await post();
      setOrderId(r.orderId);
      setStatus("open");
      setPhase("posted");
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  }

  const needsApprove = s.mode === "live" && allowance !== null && allowance < sellAtomic;
  const shown = s.mode === "demo" ? demoQuote : quote;
  const walletBal = account?.walletBalances[sell];
  const overBalance = walletBal !== undefined && sellAtomic > walletBal;
  const slippageTooHigh = slippageBps !== null && slippageBps > SLIPPAGE_MAX_BPS;
  const slippageTooLow = slippageBps !== null && slippageBps < SLIPPAGE_MIN_BPS;

  if (mode === "simple") {
    return (
      <div className="mx-auto max-w-2xl space-y-4" data-testid="spot-simple-gate">
        <h1 className="text-[22px]">Spot swaps are an Advanced feature</h1>
        <p className="text-[14px] text-oil-ink2">
          Simple mode keeps to the guided path (collateral → setting → one recommendation → sign). Swapping tokens directly means choosing amounts, slippage and order expiry yourself. Switch to Advanced if you want to do that.
        </p>
        <button className="btn-brass" onClick={() => setMode("advanced")} data-testid="spot-switch-advanced">
          Switch to Advanced
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-[22px]">Spot via CoW Protocol</h1>
        <p className="mt-1 text-[14px] text-oil-ink2">
          Batch-auction swaps on Base. You sign an intent; a solver fills it at your limit or better, or it expires with nothing spent. Oilskin never holds the tokens. Settlement contract{" "}
          <code className="mono text-oil-ink3">{COW_PROTOCOL.settlement}</code>
          {relayer && (
            <>
              {" "}
              · spender read from chain <code className="mono text-oil-ink3">{relayer}</code>
            </>
          )}
        </p>
      </div>

      <div className="card p-5 sm:p-6">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
          <div>
            <label className="label" htmlFor="sell">
              Sell
            </label>
            <div className="flex gap-2">
              <select id="sell" className="input w-32" value={sell} onChange={(e) => { setSell(e.target.value as SpotToken); setPhase("idle"); setQuote(null); }} data-testid="sell-token">
                {SPOT_TOKENS.map((t) => (
                  <option key={t} value={t} disabled={t === buy}>
                    {t}
                  </option>
                ))}
              </select>
              <input className="input" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^0-9.]/g, "")); setPhase("idle"); setQuote(null); }} data-testid="sell-amount" />
            </div>
          </div>
          <button type="button" className="btn-ghost self-center" onClick={() => { const b = buy; setBuy(sell); setSell(b); setPhase("idle"); setQuote(null); }} aria-label="Flip">
            ⇅
          </button>
          <div>
            <label className="label" htmlFor="buy">
              Buy
            </label>
            <select id="buy" className="input" value={buy} onChange={(e) => { setBuy(e.target.value as SpotToken); setPhase("idle"); setQuote(null); }} data-testid="buy-token">
              {SPOT_TOKENS.map((t) => (
                <option key={t} value={t} disabled={t === sell}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </div>

        {overBalance && (
          <p className="mt-2 text-[13px] text-status-warn" data-testid="spot-over-balance">
            Your wallet holds {fromAtomic(walletBal!, BASE_TOKENS[sell].decimals)} {sell} on Base — you cannot sell more than that.
          </p>
        )}
        <div className="mt-4">
          <label className="label" htmlFor="slippage">
            Slippage tolerance (%) — leave empty for CoW&rsquo;s suggestion
          </label>
          <input id="slippage" className="input num max-w-[160px]" inputMode="decimal" value={slippageBps === null ? "" : (slippageBps / 100).toString()} placeholder={shown ? (shown.slippageBps / 100).toString() : "auto"} onChange={(e) => { const v = e.target.value.replace(/[^0-9.]/g, ""); setSlippageBps(v === "" ? null : Math.round(Number(v) * 100)); }} data-testid="slippage" />
          <p className={`mt-1 text-[12px] ${slippageTooHigh || slippageTooLow ? "text-status-crit" : slippageBps !== null && slippageBps > SLIPPAGE_WARN_BPS ? "text-status-warn" : "text-oil-ink3"}`} data-testid="slippage-note">
            {slippageTooHigh
              ? `Above ${SLIPPAGE_MAX_BPS / 100}% is refused — that much room lets a solver or sandwich take the difference.`
              : slippageTooLow
                ? `Below ${SLIPPAGE_MIN_BPS / 100}% the order will usually just expire unfilled.`
                : slippageBps !== null && slippageBps > SLIPPAGE_WARN_BPS
                  ? "Above 1% is more than a normal market move — only if you know why."
                  : "How much worse than the quoted price you are willing to accept. CoW's batch auction usually beats the quote; the tolerance only caps the downside."}
          </p>
        </div>

        {(sell === "cbZEC" || buy === "cbZEC") && (
          <div className="note note-brass mt-4 flex flex-wrap items-center gap-2">
            <TokenMark symbol="cbZEC" size={20} />
            <span>
              cbZEC pinned at <code className="mono text-oil-ink">{CBZEC_ADDRESS}</code> — {classifyCbZecAddress(BASE_TOKENS.cbZEC.address) === "genuine" ? "genuine" : "mismatch"}. Depth is thin (~$0.9M); large orders move the price.
            </span>
            <p className="w-full text-[12.5px] text-oil-ink2" data-testid="b20-probe">
              {s.mode === "demo" ? (
                <>
                  <Chip kind="mute">Demo</Chip> The B20 policy probe (live multiplier, a simulated zero-amount transfer from your address) runs only with a wallet connected.
                </>
              ) : b20Probe === null ? (
                "Reading the B20 multiplier and simulating a zero-amount transfer from your address…"
              ) : (
                <>
                  <Chip kind={b20Probe.status === "clear" ? "good" : b20Probe.status === "blocked" ? "crit" : "warn"}>
                    {b20Probe.status === "clear" ? "Transfers from you not blocked now" : b20Probe.status === "blocked" ? "Transfer refused" : "Not checked"}
                  </Chip>{" "}
                  {b20Probe.sentence}
                </>
              )}
            </p>
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {s.mode === "demo" ? (
            <div className="note w-full">
              <Chip kind="mute">Demo</Chip> Illustrative quote from snapshot prices; connect a wallet for a CoW quote.
            </div>
          ) : (
            <button className="btn-brass" onClick={getQuote} disabled={phase === "quoting" || sellAtomic === 0n || overBalance || slippageTooHigh || slippageTooLow} data-testid="quote-btn">
              {phase === "quoting" ? "Quoting…" : "Get CoW quote"}
            </button>
          )}
        </div>

        {shown && (
          <div className="mt-5 rounded-xl border border-oil-line bg-oil-bg2 p-4" data-testid="quote">
            <dl className="num grid grid-cols-[1fr_auto] gap-y-1.5 text-[13.5px]">
              <dt className="text-oil-ink2">You sell</dt>
              <dd className="text-right font-semibold">
                {fmtAmount(shown.sellAmount, 8)} {shown.sell}
              </dd>
              <dt className="text-oil-ink2">Expected to receive</dt>
              <dd className="text-right font-semibold">
                {fmtAmount(shown.expectedBuy, 8)} {shown.buy}
              </dd>
              <dt className="text-oil-ink2">Minimum (after {shown.slippageBps / 100}% slippage)</dt>
              <dd className="text-right">
                {fmtAmount(shown.minBuy, 8)} {shown.buy}
              </dd>
              <dt className="text-oil-ink2">Solver network cost (only if filled)</dt>
              <dd className="text-right">
                {fmtAmount(shown.networkCostSell, 8)} {shown.sell}
              </dd>
              <dt className="text-oil-ink2">Expires unfilled after</dt>
              <dd className="text-right">{Math.round(shown.validForSeconds / 60)} min</dd>
            </dl>
            {s.mode === "demo" && <p className="mt-2 text-[12px] text-oil-ink3">Illustrative: {source === "live" ? "live oracle" : "snapshot"} prices for cbBTC/WETH, {fmtUsd(DEMO_CBZEC_PRICE_USDC)}/cbZEC from the Aerodrome pool tick at snapshot time. A real quote comes from the CoW order book.</p>}
          </div>
        )}

        {s.mode === "live" && (phase === "quoted" || phase === "approving" || phase === "signing") && (
          <div className="note mt-4" data-testid="spot-plain">
            {needsApprove
              ? `Step 1 is a transaction that lets CoW's settlement contract (the spender read from chain above) take exactly ${amount} ${sell} from your wallet when — and only when — your order fills. Step 2 is a free signature: your order. It fills only at your price or better before it expires; otherwise nothing is spent.`
              : `This is a free signature, not a transaction: your order. It fills only at ${fmtAmount(shown?.minBuy ?? 0, 6)} ${buy} or better before it expires (${Math.round((shown?.validForSeconds ?? 0) / 60)} min); otherwise nothing is spent. Tokens arrive in this same wallet — there is no address to type.`}
          </div>
        )}
        {s.mode === "live" && (phase === "quoted" || phase === "approving" || phase === "signing") && (
          <div className="mt-4 flex flex-wrap gap-2">
            {needsApprove && (
              <button className="btn-ghost" onClick={approve} disabled={phase === "approving"} data-testid="approve-btn">
                {phase === "approving" ? "Approving…" : `1 · Approve ${sell} for CoW`}
              </button>
            )}
            <button className="btn-brass" onClick={sign} disabled={needsApprove || phase === "signing" || !post || slippageTooHigh || slippageTooLow} data-testid="sign-order-btn">
              {phase === "signing" ? "Sign in wallet…" : `${needsApprove ? "2 · " : ""}Sign order`}
            </button>
          </div>
        )}

        {orderId && (
          <div className="mt-4 rounded-xl border border-oil-line bg-oil-bg2 p-4" data-testid="order-status">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13.5px] font-semibold">Order</span>
              <code className="mono text-oil-ink3">{orderId.slice(0, 18)}…</code>
              {status === "open" && <Chip kind="info">open — waiting for a solver</Chip>}
              {status === "fulfilled" && <Chip kind="good">filled</Chip>}
              {status === "expired" && <Chip kind="warn">expired — nothing spent</Chip>}
              {status === "cancelled" && <Chip kind="mute">cancelled</Chip>}
              {status === "presignaturePending" && <Chip kind="warn">pre-signature pending</Chip>}
            </div>
            <a className="mt-2 inline-block text-[13px] text-status-info" href={`https://explorer.cow.fi/base/orders/${orderId}`} target="_blank" rel="noreferrer">
              CoW Explorer ↗
            </a>
          </div>
        )}

        {error && (
          <div className="note note-crit mt-4" role="alert">
            {error}
          </div>
        )}
      </div>

      <Disclosures scope="spot" open />
    </div>
  );
}
