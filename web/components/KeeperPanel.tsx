"use client";

import { HF_LADDER } from "@zyo/shared";
import { describeGrant, rungPlain, type KeeperGrantRead } from "@/lib/keeper";
import type { Deployment } from "@/lib/plan";
import { fromAtomic } from "@/lib/math";
import { fmtAmount } from "@/lib/format";
import Chip from "@/components/Chip";
import { useMode } from "@/lib/mode";

const DECIMALS: Record<string, number> = { USDC: 6, cbBTC: 8, cbZEC: 8, WETH: 18, AERO: 18 };

/**
 * "Is anything actually protecting this position?" — answered from the grant
 * on the account, not from the fact that a checkbox was ticked once.
 *
 * The screen this replaces promised four ladder actions beside every position
 * while saying nothing about whether the permission behind them was live, what
 * it could reach, or when it lapses. Here: the status, the expiry, the exact
 * rungs the grant can serve (and the one that is a message, not a call), the
 * per-day budgets with what is already spent in this window, and what those
 * budgets do NOT bound.
 */
export default function KeeperPanel({
  grant,
  deployment,
  collateral,
  nowSeconds,
  onGrant,
  onRevoke,
  busy,
  venueSupported = true,
  livePoolTokens = [],
}: {
  grant: KeeperGrantRead | null;
  deployment: Deployment | null;
  collateral: string;
  nowSeconds: number;
  onGrant?: () => void;
  onRevoke?: () => void;
  busy?: boolean;
  /** False when the registry points this collateral at a venue the keeper cannot read. */
  venueSupported?: boolean;
  /** Tokens the account's live LP positions pay out; each needs a budget line or no rung can run. */
  livePoolTokens?: readonly { address: `0x${string}`; symbol: string }[];
}) {
  const { mode } = useMode();
  const status = describeGrant(grant, { keeperConfigured: !!deployment?.keeper, nowSeconds, venueSupported, livePoolTokens });
  const covered = new Set(status.rungsCovered.map((r) => r.id));

  return (
    <div className="card p-5" data-testid="keeper-panel" data-status={status.kind}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px]">Keeper protection</h3>
        <Chip kind={status.tone === "good" ? "good" : status.tone === "crit" ? "crit" : status.tone === "warn" ? "warn" : "mute"}>
          <span data-testid="keeper-status-label">{status.label}</span>
        </Chip>
      </div>
      <p className="mt-2 text-[13.5px] leading-relaxed text-oil-ink" data-testid="keeper-plain">
        {status.plain}
      </p>

      {grant?.active && (
        <p className="num mt-1.5 text-[12.5px] text-oil-ink3" data-testid="keeper-expiry">
          Expires {new Date(grant.expiry * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC
          {status.daysLeft !== null ? ` · ${status.daysLeft} day${status.daysLeft === 1 ? "" : "s"} left` : ""} · budget window {grant.period / 3600} h
        </p>
      )}

      <ul className="mt-3 space-y-1 text-[12.8px] text-oil-ink2" data-testid="keeper-rungs">
        {HF_LADDER.map((r) => {
          const onChain = r.action !== "notify";
          const ok = onChain && covered.has(r.id);
          return (
            <li key={r.id} className="flex items-start gap-2">
              <span className={`mt-[3px] h-2 w-2 flex-none rounded-full ${!onChain ? "bg-oil-ink3" : ok ? "bg-status-good" : "bg-status-crit"}`} aria-hidden />
              <span>
                <b className="text-oil-ink">
                  {r.label} (HF &lt; {r.hf.toFixed(2)})
                </b>{" "}
                — {rungPlain(r, collateral)}
                {!onChain ? <span className="text-oil-ink3"> · a message, not a transaction: no permission produces it</span> : ok ? "" : <span className="text-status-crit"> · not possible right now</span>}
              </span>
            </li>
          );
        })}
      </ul>

      {grant?.active && grant.tokens.length > 0 && (
        <div className="mt-3">
          <div className="text-[12px] text-oil-ink3">What the keeper may move directly, per day</div>
          <ul className="num mt-1 space-y-0.5 text-[12.5px] text-oil-ink2" data-testid="keeper-budgets">
            {grant.tokens.map((t) => (
              <li key={t.token} className="flex justify-between gap-4">
                <span>{t.symbol}</span>
                <span>
                  {fmtAmount(fromAtomic(t.amountPerPeriod, DECIMALS[t.symbol] ?? 18), 4)}
                  <span className="text-oil-ink3"> · {fmtAmount(fromAtomic(t.spent, DECIMALS[t.symbol] ?? 18), 4)} used this window</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11.5px] text-oil-ink3">
            These cap direct transfers and approvals the keeper&rsquo;s call makes. Value that Aave or the Snuggle engine moves inside that same call — an Aave withdrawal, an engine withdrawal — is not bounded by them.
          </p>
        </div>
      )}

      {mode === "advanced" && grant && (
        <dl className="mono mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-oil-ink2" data-testid="keeper-raw">
          <dt className="text-oil-ink3">keeper</dt>
          <dd>{grant.keeper}</dd>
          <dt className="text-oil-ink3">target · selector</dt>
          <dd>
            {grant.target} · {grant.selector} (StrategyRouter.unwind)
          </dd>
          <dt className="text-oil-ink3">allowCallback</dt>
          <dd>{String(grant.allowCallback)} — false would make every keeper call revert NotActivePeripheral inside the router</dd>
          <dt className="text-oil-ink3">ETH per period</dt>
          <dd>
            {grant.maxValuePerPeriod.toString()} wei · {grant.valueSpent.toString()} spent
          </dd>
        </dl>
      )}

      {(onGrant || onRevoke) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {onGrant && status.kind !== "not-configured" && status.kind !== "venue-unsupported" && (
            <button className="btn-brass" onClick={onGrant} disabled={busy} data-testid="keeper-grant-btn">
              {status.kind === "active" ? "Renew for another 30 days" : "Grant keeper protection"}
            </button>
          )}
          {onRevoke && grant?.active && (
            <button className="btn-ghost" onClick={onRevoke} disabled={busy} data-testid="keeper-revoke-btn">
              Revoke every permission
            </button>
          )}
        </div>
      )}
    </div>
  );
}
