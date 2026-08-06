"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CURATED_POOLS,
  RANGE_PRESETS,
  RHEA,
  classifyZcashAddress,
  presetToLpParams,
  validateLpParams,
  type BorrowAssetSymbol,
  type LpParams,
  type RangePreset,
  type RewardPreference,
  type StrategyMode,
} from "@zyo/shared";
import {
  borrowUsd,
  fmtUsd,
  healthFactorForLtv,
  hfColor,
  hfLabel,
  liquidationPrice,
} from "@/lib/estimates";
import { MOCK_POOL_APRS } from "@/lib/mock";
import StatusPill from "@/components/StatusPill";

type Step = "mode" | "amount" | "borrow" | "pool" | "params" | "rewards" | "review" | "deposit";

const BORROW_ASSETS: { symbol: BorrowAssetSymbol; blurb: string }[] = [
  { symbol: "USDC", blurb: "Stable, predictable debt. The default choice." },
  { symbol: "cbBTC", blurb: "BTC-denominated debt — short-ZEC/long-BTC tilt." },
  { symbol: "WETH", blurb: "ETH-denominated debt for ETH-pair strategies." },
];

export default function DepositWizard() {
  const [step, setStep] = useState<Step>("mode");
  const [mode, setMode] = useState<StrategyMode>("SIMPLE_LENDING");
  const [zecAmount, setZecAmount] = useState("10");
  const [zcashAddress, setZcashAddress] = useState("");
  const [wantBorrow, setWantBorrow] = useState(false);
  const [borrowAsset, setBorrowAsset] = useState<BorrowAssetSymbol>("USDC");
  const [ltvBps, setLtvBps] = useState(RHEA.defaultLtvBps);
  const [poolId, setPoolId] = useState<string | null>(null);
  const [preset, setPreset] = useState<RangePreset>("MODERATE");
  const [lpParams, setLpParams] = useState<LpParams>(presetToLpParams("MODERATE"));
  const [rewardPref, setRewardPref] = useState<RewardPreference>("COMPOUND");
  const [zecPrice, setZecPrice] = useState(48.75);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: string; zecDepositAddress: string } | null>(null);

  useEffect(() => {
    fetch("/api/price")
      .then((r) => r.json())
      .then((d) => d.zecUsd && setZecPrice(d.zecUsd))
      .catch(() => undefined);
  }, []);

  const isFull = mode === "FULL_STRATEGY";
  const borrows = isFull || wantBorrow;
  const zec = Number(zecAmount) || 0;
  const debtUsd = borrows ? borrowUsd(zec, zecPrice, ltvBps) : 0;
  const hf = borrows ? healthFactorForLtv(ltvBps) : Infinity;
  const liqPrice = borrows ? liquidationPrice(zecPrice, ltvBps) : 0;
  const pools = useMemo(
    () => CURATED_POOLS.filter((p) => p.entryAsset === borrowAsset),
    [borrowAsset]
  );
  const pool = CURATED_POOLS.find((p) => p.id === poolId) ?? null;
  const addrKind = classifyZcashAddress(zcashAddress);
  const paramErrors = validateLpParams(lpParams);

  const flow: Step[] = isFull
    ? ["mode", "amount", "borrow", "pool", "params", "rewards", "review", "deposit"]
    : wantBorrow
      ? ["mode", "amount", "borrow", "review", "deposit"]
      : ["mode", "amount", "review", "deposit"];
  const stepIdx = flow.indexOf(step);

  const canNext = (): boolean => {
    switch (step) {
      case "amount":
        return zec > 0 && addrKind !== "invalid";
      case "pool":
        return pool !== null;
      case "params":
        return paramErrors.length === 0;
      default:
        return true;
    }
  };

  const next = () => setStep(flow[Math.min(stepIdx + 1, flow.length - 1)]);
  const back = () => setStep(flow[Math.max(stepIdx - 1, 0)]);

  async function createStrategy() {
    setCreating(true);
    try {
      const res = await fetch("/api/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          zecAmount,
          zcashAddress,
          borrow: borrows ? { asset: borrowAsset, targetLtvBps: ltvBps } : null,
          pool: isFull ? poolId : null,
          lpParams: isFull ? lpParams : null,
          rewardPreference: isFull ? rewardPref : "COMPOUND",
        }),
      });
      setCreated(await res.json());
      setStep("deposit");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      {/* progress */}
      <div className="mb-8 flex items-center gap-1.5">
        {flow.slice(0, -1).map((s, i) => (
          <div
            key={s}
            className={`h-1 flex-1 rounded-full ${i <= stepIdx ? "bg-zec" : "bg-ink-raised"}`}
          />
        ))}
      </div>

      {step === "mode" && (
        <section className="space-y-4">
          <h1 className="text-2xl font-bold text-white">How do you want to earn?</h1>
          {(
            [
              {
                m: "SIMPLE_LENDING" as const,
                title: "Simple lending",
                tag: "Lower risk",
                body: "Supply ZEC on Rhea Finance and earn supply APY. Optionally borrow against it. No Base chain involvement. Upgrade to the full strategy any time.",
              },
              {
                m: "FULL_STRATEGY" as const,
                title: "Full strategy",
                tag: "Higher yield · managed",
                body: "Supply ZEC, borrow an asset, and deploy it into a MaxFi / SnuggleFi concentrated-liquidity position on Base with your exact parameters. Rewards compound or flow back to your Zcash wallet.",
              },
            ]
          ).map((c) => (
            <button
              key={c.m}
              onClick={() => setMode(c.m)}
              className={`card w-full p-5 text-left transition ${
                mode === c.m ? "border-zec" : "hover:border-ink-muted"
              }`}
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="font-semibold text-white">{c.title}</span>
                <span className="text-xs text-ink-muted">{c.tag}</span>
              </div>
              <p className="text-sm text-ink-muted">{c.body}</p>
            </button>
          ))}
        </section>
      )}

      {step === "amount" && (
        <section className="space-y-5">
          <h1 className="text-2xl font-bold text-white">Deposit amount</h1>
          <div>
            <label className="label">ZEC to deposit</label>
            <input
              className="input text-lg"
              inputMode="decimal"
              value={zecAmount}
              onChange={(e) => setZecAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            />
            <p className="mt-1.5 text-sm text-ink-muted">
              ≈ {fmtUsd(zec * zecPrice)} at {fmtUsd(zecPrice)}/ZEC
            </p>
          </div>
          <div>
            <label className="label">Your Zcash address (refunds & rewards)</label>
            <input
              className="input font-mono text-sm"
              placeholder="t1…  (transparent) or u1… (unified)"
              value={zcashAddress}
              onChange={(e) => setZcashAddress(e.target.value.trim())}
            />
            <div className="mt-1.5 text-sm">
              {zcashAddress.length === 0 ? (
                <span className="text-ink-muted">
                  Where ZEC returns to when you withdraw or take rewards.
                </span>
              ) : addrKind === "transparent" ? (
                <StatusPill kind="good" label="Transparent — supported (arrivals publicly visible)" />
              ) : addrKind === "unified" ? (
                <StatusPill kind="info" label="Unified — private; support confirmed at quote time" />
              ) : (
                <StatusPill kind="serious" label="Not a recognized Zcash address" />
              )}
            </div>
          </div>
          {!isFull && (
            <label className="card flex cursor-pointer items-center justify-between p-4">
              <div>
                <div className="font-medium text-white">Borrow against my ZEC</div>
                <div className="text-sm text-ink-muted">
                  Take a loan (USDC, cbBTC, WETH) while your ZEC earns supply APY.
                </div>
              </div>
              <input
                type="checkbox"
                checked={wantBorrow}
                onChange={(e) => setWantBorrow(e.target.checked)}
                className="h-5 w-5 accent-zec"
              />
            </label>
          )}
        </section>
      )}

      {step === "borrow" && (
        <section className="space-y-5">
          <h1 className="text-2xl font-bold text-white">Borrow settings</h1>
          <div className="grid gap-3 sm:grid-cols-3">
            {BORROW_ASSETS.map((a) => (
              <button
                key={a.symbol}
                onClick={() => {
                  setBorrowAsset(a.symbol);
                  setPoolId(null);
                }}
                className={`card p-4 text-left transition ${
                  borrowAsset === a.symbol ? "border-zec" : "hover:border-ink-muted"
                }`}
              >
                <div className="font-semibold text-white">{a.symbol}</div>
                <div className="mt-1 text-xs text-ink-muted">{a.blurb}</div>
              </button>
            ))}
          </div>
          <div>
            <div className="mb-1.5 flex justify-between">
              <label className="label mb-0">Target loan-to-value</label>
              <span className="text-sm font-semibold text-white">{(ltvBps / 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min={1000}
              max={RHEA.maxUserLtvBps}
              step={100}
              value={ltvBps}
              onChange={(e) => setLtvBps(Number(e.target.value))}
              className="w-full accent-zec"
            />
            <div className="mt-1 flex justify-between text-xs text-ink-muted">
              <span>10% · safer</span>
              <span>{RHEA.maxUserLtvBps / 100}% · max allowed</span>
            </div>
          </div>
          <div className="card grid grid-cols-3 gap-4 p-4 text-center">
            <div>
              <div className="text-xs text-ink-muted">You borrow</div>
              <div className="mt-1 font-bold text-white">{fmtUsd(debtUsd)}</div>
              <div className="text-xs text-ink-muted">{borrowAsset}</div>
            </div>
            <div>
              <div className="text-xs text-ink-muted">Health factor</div>
              <div className={`mt-1 font-bold ${hfColor(hf)}`}>{hf.toFixed(2)}</div>
              <div className="text-xs text-ink-muted">{hfLabel(hf)}</div>
            </div>
            <div>
              <div className="text-xs text-ink-muted">Liq. price (ZEC)</div>
              <div className="mt-1 font-bold text-white">{fmtUsd(liqPrice)}</div>
              <div className="text-xs text-ink-muted">
                −{(100 - (liqPrice / zecPrice) * 100).toFixed(0)}% from now
              </div>
            </div>
          </div>
          <p className="text-sm leading-relaxed text-ink-muted">
            The agent watches this position continuously: it notifies you at HF {"<"} 1.5,
            suggests deleveraging at HF {"<"} 1.2, and can emergency-unwind near liquidation.
          </p>
        </section>
      )}

      {step === "pool" && (
        <section className="space-y-4">
          <h1 className="text-2xl font-bold text-white">Choose a pool</h1>
          <p className="text-sm text-ink-muted">
            Curated Base pools entered single-sided with your borrowed {borrowAsset}. APR is
            recent, not guaranteed.
          </p>
          <div className="space-y-3">
            {pools.map((p) => (
              <button
                key={p.id}
                onClick={() => setPoolId(p.id)}
                className={`card w-full p-4 text-left transition ${
                  poolId === p.id ? "border-zec" : "hover:border-ink-muted"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-white">
                    {p.token0}/{p.token1}
                    <span className="ml-2 text-xs font-normal text-ink-muted">
                      {p.dex.replace("_", " ")} · {(p.feeTierBps / 100).toFixed(2)}% ·{" "}
                      {p.protocol === "MAXFI" ? "MaxFi" : "SnuggleFi"}
                    </span>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-status-good">
                      {MOCK_POOL_APRS[p.id]?.toFixed(1) ?? "—"}%
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-ink-muted">
                      est. APR
                    </div>
                  </div>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <StatusPill
                    kind={p.riskTag === "STABLE" ? "good" : p.riskTag === "BLUE_CHIP" ? "neutral" : "warn"}
                    label={p.riskTag.replace("_", " ").toLowerCase()}
                  />
                  <span className="text-xs text-ink-muted">{p.description}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {step === "params" && (
        <section className="space-y-5">
          <h1 className="text-2xl font-bold text-white">Position settings</h1>
          <div className="grid gap-3 sm:grid-cols-3">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.preset}
                onClick={() => {
                  setPreset(p.preset);
                  setLpParams(presetToLpParams(p.preset));
                }}
                className={`card p-4 text-left transition ${
                  preset === p.preset ? "border-zec" : "hover:border-ink-muted"
                }`}
              >
                <div className="font-semibold text-white">{p.label}</div>
                <div className="mt-1 text-xs leading-relaxed text-ink-muted">{p.description}</div>
              </button>
            ))}
          </div>
          <div className="card space-y-5 p-5">
            <div>
              <div className="mb-1.5 flex justify-between">
                <label className="label mb-0">Range width</label>
                <span className="text-sm font-semibold text-white">
                  {(lpParams.rangeWidthBps / 100).toFixed(2)}%
                </span>
              </div>
              <input
                type="range"
                min={10}
                max={5000}
                step={10}
                value={lpParams.rangeWidthBps}
                onChange={(e) => {
                  setPreset("CUSTOM");
                  setLpParams({ ...lpParams, rangeWidthBps: Number(e.target.value) });
                }}
                className="w-full accent-zec"
              />
              <div className="mt-1 flex justify-between text-xs text-ink-muted">
                <span>0.1% · max fees, frequent rebalancing</span>
                <span>50% · set-and-forget</span>
              </div>
            </div>
            <div>
              <div className="mb-1.5 flex justify-between">
                <label className="label mb-0">Rebalance delay</label>
                <span className="text-sm font-semibold text-white">
                  {lpParams.rebalanceDelayHours}h
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={168}
                step={1}
                value={lpParams.rebalanceDelayHours}
                onChange={(e) => {
                  setPreset("CUSTOM");
                  setLpParams({ ...lpParams, rebalanceDelayHours: Number(e.target.value) });
                }}
                className="w-full accent-zec"
              />
              <div className="mt-1 flex justify-between text-xs text-ink-muted">
                <span>0h · reposition immediately</span>
                <span>168h · wait out a full week</span>
              </div>
            </div>
            <label className="flex cursor-pointer items-center justify-between">
              <div>
                <div className="font-medium text-white">Auto-compound fees</div>
                <div className="text-sm text-ink-muted">
                  Matching-token fees reinvest automatically inside the position.
                </div>
              </div>
              <input
                type="checkbox"
                checked={lpParams.autoCompoundEnabled}
                onChange={(e) =>
                  setLpParams({ ...lpParams, autoCompoundEnabled: e.target.checked })
                }
                className="h-5 w-5 accent-zec"
              />
            </label>
          </div>
          {paramErrors.length > 0 && (
            <p className="text-sm text-status-serious">{paramErrors.join(" ")}</p>
          )}
        </section>
      )}

      {step === "rewards" && (
        <section className="space-y-4">
          <h1 className="text-2xl font-bold text-white">What happens to rewards?</h1>
          {(
            [
              {
                r: "COMPOUND" as const,
                title: "Compound into the position",
                body: "Claimed rewards are re-deposited into your LP position, growing the principal. Cheapest option — no bridging.",
              },
              {
                r: "SEND_TO_ZCASH" as const,
                title: "Send to my Zcash wallet",
                body: `Rewards are converted and delivered as native ZEC to ${zcashAddress || "your address"} via NEAR Intents. The agent claims only when rewards clear gas + bridge costs by a safe multiple.`,
              },
            ]
          ).map((c) => (
            <button
              key={c.r}
              onClick={() => setRewardPref(c.r)}
              className={`card w-full p-5 text-left transition ${
                rewardPref === c.r ? "border-zec" : "hover:border-ink-muted"
              }`}
            >
              <div className="font-semibold text-white">{c.title}</div>
              <p className="mt-1 text-sm text-ink-muted">{c.body}</p>
            </button>
          ))}
          <p className="text-xs text-ink-muted">
            A percentage split between the two is on the roadmap; you can switch preference any
            time from the dashboard.
          </p>
        </section>
      )}

      {step === "review" && (
        <section className="space-y-4">
          <h1 className="text-2xl font-bold text-white">Review</h1>
          <div className="card divide-y divide-ink-border">
            <Row k="Mode" v={isFull ? "Full strategy" : "Simple lending"} />
            <Row k="Deposit" v={`${zec} ZEC (≈ ${fmtUsd(zec * zecPrice)})`} />
            <Row k="Zcash address" v={zcashAddress} mono />
            {borrows && (
              <>
                <Row
                  k="Borrow"
                  v={`${fmtUsd(debtUsd)} in ${borrowAsset} @ ${(ltvBps / 100).toFixed(0)}% LTV`}
                />
                <Row k="Health factor at entry" v={hf.toFixed(2)} />
                <Row k="Liquidation price" v={`${fmtUsd(liqPrice)} per ZEC`} />
              </>
            )}
            {isFull && pool && (
              <>
                <Row
                  k="Pool"
                  v={`${pool.token0}/${pool.token1} · ${pool.dex.replace("_", " ")} · ${pool.protocol === "MAXFI" ? "MaxFi" : "SnuggleFi"}`}
                />
                <Row
                  k="Position"
                  v={`±${(lpParams.rangeWidthBps / 200).toFixed(2)}% range · ${lpParams.rebalanceDelayHours}h delay · auto-compound ${lpParams.autoCompoundEnabled ? "on" : "off"}`}
                />
                <Row
                  k="Rewards"
                  v={rewardPref === "COMPOUND" ? "Compound into position" : "Send to Zcash wallet"}
                />
              </>
            )}
          </div>
          <p className="text-sm leading-relaxed text-ink-muted">
            Next you will get a personal deposit address. Funds route: Zcash → Rhea (supply
            {borrows ? " + borrow" : ""}){isFull ? " → NEAR Intents → Base → LP position" : ""}.
            You can watch every hop on the dashboard.
          </p>
        </section>
      )}

      {step === "deposit" && (
        <section className="space-y-5 text-center">
          <h1 className="text-2xl font-bold text-white">Send your ZEC</h1>
          <div className="card mx-auto max-w-md p-6">
            <div className="mx-auto mb-4 flex h-40 w-40 items-center justify-center rounded-lg bg-white p-2 text-xs text-ink-bg">
              QR — {created?.zecDepositAddress ?? "…"}
            </div>
            <div className="rounded-lg bg-ink-bg p-3 font-mono text-sm text-zec">
              {created?.zecDepositAddress ?? "generating…"}
            </div>
            <p className="mt-3 text-sm text-ink-muted">
              Send exactly <span className="font-semibold text-white">{zec} ZEC</span> from any
              Zcash wallet. Strategy <span className="font-mono">{created?.id}</span> activates
              automatically on arrival — track it on the dashboard.
            </p>
          </div>
          <a href="/dashboard" className="btn-primary inline-block">
            Go to dashboard
          </a>
        </section>
      )}

      {/* nav */}
      {step !== "deposit" && (
        <div className="mt-8 flex justify-between">
          <button onClick={back} disabled={stepIdx === 0} className="btn-ghost disabled:opacity-30">
            Back
          </button>
          {step === "review" ? (
            <button onClick={createStrategy} disabled={creating} className="btn-primary">
              {creating ? "Creating…" : "Create strategy"}
            </button>
          ) : (
            <button onClick={next} disabled={!canNext()} className="btn-primary">
              Continue
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <span className="shrink-0 text-sm text-ink-muted">{k}</span>
      <span className={`text-right text-sm text-white ${mono ? "break-all font-mono" : ""}`}>
        {v}
      </span>
    </div>
  );
}
