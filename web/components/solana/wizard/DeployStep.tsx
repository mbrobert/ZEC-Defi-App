"use client";

import { fmtPct, fmtSignedPct, fmtUsd } from "@/lib/format";
import { refusalPlain, unpricedPlain, type ForecastCell, type ForecastView } from "@/lib/forecast";
import { useMode } from "@/lib/mode";
import { SOLANA_DISCLOSURES } from "@/lib/solana/copy";
import { SOLANA_ENV } from "@/lib/solana/env";
import { loopAcknowledgment, loopCells, loopCellsPerPool, type LoopChoice, type LoopPlan } from "@/lib/solana/loop";
import type { SolanaOpenPlan } from "@/lib/solana/plan";
import Chip from "@/components/Chip";

/**
 * Step 4: where the borrowed USDC goes. Stay on Solana (idle in the Account, the default), or the cross-chain loop
 * (BUILD-PLAN D6): cross to the user's own Base account and work in an Aerodrome pool — shown as the forecast the
 * yield service prices with Kamino's borrow side, never as a gate (D4/D5). Simple lists each pool at its best
 * setting; Advanced lists every pool × setting with both models. The reserve that stays behind is named on the
 * screen, the acknowledgment is the Base wizard's with the loop's own sentence, and while the crossing is not
 * enabled in this build the forecast is information and the option says so.
 */
export default function DeployStep({ plan, forecast, loading, choice, loop, onChoice, acknowledged, onAcknowledge }: {
  plan: SolanaOpenPlan;
  forecast: ForecastView;
  loading: boolean;
  choice: LoopChoice;
  loop: LoopPlan;
  onChoice: (c: LoopChoice) => void;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
}) {
  const { mode } = useMode();
  const enabled = SOLANA_ENV.loopEnabled;
  const noBorrow = plan.borrowUsdc <= 0;
  const cells = mode === "simple" ? loopCellsPerPool(forecast, plan.ltvBps) : loopCells(forecast, plan.ltvBps);
  const isSel = (c: ForecastCell) => choice.kind === "base" && choice.poolId === c.poolId && choice.setting === c.setting;
  const pick = (c: ForecastCell) => {
    if (!enabled || !c.allowed) return;
    onChoice({ kind: "base", poolId: c.poolId, setting: c.setting });
  };
  const forecastLine = `Forecast: ${forecast.source === "live" ? "yield service" : "yield model, demo"}${forecast.stale ? " · SAMPLE STALE — read the numbers as history, not as today" : ""}${forecast.emissionsSampledAt ? ` · emissions sampled ${forecast.emissionsSampledAt.slice(0, 16).replace("T", " ")}Z` : ""}${forecast.volatilityAsOf ? ` · σ as of ${forecast.volatilityAsOf}` : ""} · the loan and its rate are Kamino's`;

  return (
    <div className="space-y-5" data-testid="sol-deploy">
      <div>
        <h2 className="text-[19px]">Where does the borrowed USDC go?</h2>
        <p className="mt-1 text-[13.5px] text-oil-ink2">
          {noBorrow
            ? "You are borrowing nothing, so there is nothing to place. Continue."
            : `Two choices. It can stay in your Oilskin account on Solana, where it earns nothing and is ready to repay. Or it can cross to your own Oilskin account on Base through Circle and work in an Aerodrome pool — the loop. Either way ${fmtUsd(loop.reserveUsdc)} USDC (${fmtPct(loop.reserveFraction * 100)} of the debt) stays on Solana as the reserve: the one repay the keeper can make without crossing a chain.`}
        </p>
      </div>

      <div role="radiogroup" aria-label="Where the borrowed USDC goes" className="space-y-3">
        <button type="button" role="radio" aria-checked={choice.kind === "keep"} className={`opt w-full p-4 text-left ${choice.kind === "keep" ? "sel" : ""}`} onClick={() => onChoice({ kind: "keep" })} data-testid="sol-loop-keep">
          <div className="text-[14px] font-semibold">Stay on Solana</div>
          <p className="mt-1 text-[13px] text-oil-ink2">Idle in your Oilskin account, ready to repay or to send home. Nothing crosses a chain; the keeper's protection is one transaction.</p>
        </button>

        {!noBorrow && (
          <div className="card p-4" data-testid="sol-loop-base">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[14px] font-semibold">Cross to Base and work in an Aerodrome pool</div>
              {!enabled && <Chip kind="mute">not in this build</Chip>}
              {loading && <Chip kind="info">updating</Chip>}
            </div>
            <p className="mt-1 text-[13px] text-oil-ink2">
              {fmtUsd(loop.crossUsdc > 0 ? loop.crossUsdc : Math.max(0, plan.borrowUsdc - loop.reserveUsdc))} USDC would cross; the forecast below is priced on the rate Kamino charges after your borrow. Choosing a pool commits nothing yet — the crossing is signed later, on both chains.
            </p>
            {!enabled && (
              <p className="mt-2 text-[12.5px] text-oil-ink3" data-testid="sol-loop-disabled">
                This build shows the loop&rsquo;s forecast and cannot yet sign the crossing: the Solana burn and the Base steps land with the devnet ↔ Sepolia run. The numbers are information.
              </p>
            )}
            <p className="mt-2 text-[12px] text-oil-ink3" data-testid="sol-loop-forecast-line">{forecastLine}</p>
            <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {cells.map((c) => {
                const refused = !c.allowed && c.refusals.length > 0;
                const un = loop.cell && isSel(c) ? loop.userNetPct : null;
                const selected = isSel(c);
                const tone = c.lpNetPct === null ? "text-oil-ink3" : c.lpNetPct >= 0 ? "text-status-good" : "text-status-crit";
                return (
                  <li key={`${c.poolId}-${c.setting}`}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-disabled={!enabled || refused}
                      className={`opt w-full p-3 text-left ${selected ? "sel" : ""} ${!enabled || refused ? "opacity-55" : ""}`}
                      onClick={() => pick(c)}
                      data-testid={`sol-loop-cell-${c.poolId}-${c.setting}`}
                      data-priced={c.lpPriced ? "1" : undefined}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13.5px] font-semibold">{c.pool.token0}/{c.pool.token1}</span>
                        <Chip kind="mute">{c.setting} · ±{(c.rangeWidthBps / 200).toFixed(1)} %</Chip>
                      </div>
                      {c.lpPriced && c.lpNetPct !== null ? (
                        <p className={`num mt-1 text-[13px] ${tone}`}>
                          LP net {fmtSignedPct(c.lpNetPct)} a year{c.mcLpNetPct !== null ? ` (stricter model ${fmtSignedPct(c.mcLpNetPct)})` : ""}
                          {un !== null ? ` · your net ${fmtSignedPct(un)} at ${fmtPct(plan.ltvBps / 100, 1)} LTV` : ""}
                        </p>
                      ) : (
                        <p className="mt-1 text-[12.5px] text-oil-ink3">No forecast: {unpricedPlain(c.lpUnpricedReason)}</p>
                      )}
                      {refused && <p className="mt-1 text-[12.5px] text-oil-crit">{c.refusals.map((r) => refusalPlain(r, "kamino")).join(" ")}</p>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {loop.kind === "base" && loop.cell && (
        <>
          <div className="card p-4" data-testid="sol-loop-summary">
            <div className="text-[14px] font-semibold">What the loop would be</div>
            <dl className="mt-2 grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2">
              <div><dt className="text-oil-ink3">Crosses to Base</dt><dd className="num">{fmtUsd(loop.crossUsdc)} USDC into {loop.cell.pool.token0}/{loop.cell.pool.token1} ({loop.cell.setting})</dd></div>
              <div><dt className="text-oil-ink3">Stays on Solana</dt><dd className="num">{fmtUsd(loop.reserveUsdc)} USDC, the reserve</dd></div>
              <div><dt className="text-oil-ink3">Your net at this LTV</dt><dd className="num">{loop.userNetPct !== null ? `${fmtSignedPct(loop.userNetPct)} a year` : "—"}{loop.mcUserNetPct !== null ? ` (stricter model ${fmtSignedPct(loop.mcUserNetPct)})` : ""}</dd></div>
              <div><dt className="text-oil-ink3">Kamino&rsquo;s rate after your borrow</dt><dd className="num">{loop.cell.borrowAprAfterPct !== null ? `${fmtPct(loop.cell.borrowAprAfterPct)} a year` : loop.cell.borrowAprNowPct !== null ? `${fmtPct(loop.cell.borrowAprNowPct)} now (snapshot; the post-borrow rate is live only)` : "—"}</dd></div>
            </dl>
          </div>
          {(["cross_chain_circle", "cross_chain_two_chains"] as const).map((id) => (
            <div key={id} className="card p-4" data-testid={`sol-loop-disclosure-${id}`}>
              <div className="text-[14px] font-semibold">{SOLANA_DISCLOSURES[id].title}</div>
              <p className="mt-1 text-[13px] text-oil-ink2">{SOLANA_DISCLOSURES[id].body}</p>
            </div>
          ))}
          <label className="flex items-start gap-3 text-[13.5px]">
            <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} data-testid="sol-loop-ack" />
            <span data-testid="sol-loop-ack-text">{loopAcknowledgment(loop, plan, forecast)}</span>
          </label>
        </>
      )}
    </div>
  );
}
