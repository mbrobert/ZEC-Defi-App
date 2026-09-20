"use client";

import { HF_LADDER } from "@zyo/shared";
import { fmtAgo, fmtPct, fmtUsd } from "@/lib/format";
import { hfBand } from "@/lib/math";
import { grantRemaining, type SolanaPosition } from "@/lib/solana/reads";
import type { SolanaBorrowView } from "@/lib/solana/yield";
import { fromUnits } from "@/lib/solana/plan";
import { explorerAccount } from "@/lib/solana/env";
import { solanaRungPlain } from "@/components/solana/wizard/HfStep";
import Chip from "@/components/Chip";

/**
 * The connected wallet's position: collateral, debt, the health factor recomputed from Scope's price (Kamino's
 * cached one beside it with its slot), the price at which liquidation begins, the ladder the keeper runs today,
 * the grant's state, and the two things only the owner can do — close everything, revoke the keeper.
 */
export default function SolanaPositionCard({ position, view, nowS, onClose, onRevoke, busy }: { position: SolanaPosition; view: SolanaBorrowView; nowS: number; onClose: () => void; onRevoke: () => void; busy: boolean }) {
  const p = position;
  const collateralZec = fromUnits(p.collateralZecUnits, 8);
  const debtUsdc = fromUnits(p.debtUsdcUnits, 6);
  const idleUsdc = fromUnits(p.accountUsdc.amount, 6);
  const price = view.zecPriceUsd;
  const lt = view.liquidationThresholdBps;
  const hf = price !== null && lt !== null && debtUsdc > 0 ? (collateralZec * price * lt) / 10_000 / (debtUsdc * (view.usdcPriceUsd ?? 1)) : null;
  const liq = lt !== null && debtUsdc > 0 && collateralZec > 0 ? (debtUsdc * (view.usdcPriceUsd ?? 1)) / ((collateralZec * lt) / 10_000) : null;
  const band = hfBand(debtUsdc > 0 ? hf : null, HF_LADDER);
  const grant = p.grant && p.user ? grantRemaining(p.grant, p.user.grantEpoch, BigInt(nowS)) : null;
  return (
    <div className="card p-5 space-y-4" data-testid="sol-position">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[15px] font-semibold">ZEC on Kamino, Solana</div>
          <a className="text-[12px] text-oil-ink3 underline" href={explorerAccount(p.account.toBase58())} target="_blank" rel="noreferrer">
            account {p.account.toBase58().slice(0, 8)}…
          </a>
        </div>
        {debtUsdc > 0 ? <Chip kind={band.kind}>{band.label}</Chip> : <Chip kind="mute">no debt</Chip>}
      </div>
      <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
        <div>
          <dt className="text-oil-ink3">Collateral</dt>
          <dd className="num text-[15px]">{collateralZec.toLocaleString(undefined, { maximumFractionDigits: 4 })} ZEC</dd>
          <dd className="num text-[12px] text-oil-ink3">{price !== null ? `≈ ${fmtUsd(collateralZec * price)}` : ""}</dd>
        </div>
        <div>
          <dt className="text-oil-ink3">Debt</dt>
          <dd className="num text-[15px]">{fmtUsd(debtUsdc)} USDC</dd>
          <dd className="num text-[12px] text-oil-ink3">{idleUsdc > 0 ? `${fmtUsd(idleUsdc)} idle in the account` : ""}</dd>
        </div>
        <div>
          <dt className="text-oil-ink3">Health factor</dt>
          <dd className="num text-[15px]" data-testid="sol-hf">
            {hf === null ? (debtUsdc > 0 ? "unreadable" : "∞") : hf.toFixed(3)}
          </dd>
          <dd className="num text-[12px] text-oil-ink3">{p.obligation?.cachedHf !== null && p.obligation?.cachedHf !== undefined ? `Kamino cached ${p.obligation.cachedHf.toFixed(3)} at slot ${p.obligation.slot.toLocaleString()}` : ""}</dd>
        </div>
        <div>
          <dt className="text-oil-ink3">Liquidation begins at</dt>
          <dd className="num text-[15px]">{liq !== null ? `${fmtUsd(liq)} / ZEC` : "—"}</dd>
          <dd className="num text-[12px] text-oil-ink3">{price !== null ? `ZEC ${fmtUsd(price)} now (${view.source === "live" ? fmtAgo(view.sampledAt ?? new Date().toISOString()) : "snapshot"})` : ""}</dd>
        </div>
      </dl>
      <div>
        <div className="text-[13px] font-semibold">Keeper protection</div>
        {grant && p.grant ? (
          <p className="mt-1 text-[13px] text-oil-ink2">
            {grant.live ? <Chip kind="good">live</Chip> : <Chip kind="warn">not live</Chip>} until {new Date(Number(p.grant.expiryTs) * 1000).toISOString().slice(0, 10)} · left this period: {fmtUsd(fromUnits(grant.repayLeft, 6))} USDC to repay{p.grant.sellZecPerPeriod === 0n ? " · repay-only: the keeper may not sell your ZEC (your choice; re-grant to change it)" : `, ${fromUnits(grant.sellLeft, 8)} ZEC to sell · allowance ${fmtPct(p.grant.maxSellSlippageBps / 100)} under the oracle`}.
          </p>
        ) : (
          <p className="mt-1 text-[13px] text-oil-ink2">No keeper permission on this account. Only the first rung — a message — exists; you act yourself.</p>
        )}
        <ol className="mt-2 space-y-1 text-[12.5px] text-oil-ink2">
          {HF_LADDER.map((r) => (
            <li key={r.id}>
              <span className="num text-oil-ink3">HF {r.hf.toFixed(2)}</span> — {solanaRungPlain(r)}
            </li>
          ))}
        </ol>
        <p className="mt-1 text-[12px] text-oil-ink3">The keeper reads the shared ladder for every Solana position today; a per-position ladder from the entry you chose comes with the next program version.</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-brass" onClick={onClose} disabled={busy || (debtUsdc === 0 && collateralZec === 0 && p.accountZec.amount === 0n && p.accountUsdc.amount === 0n)} data-testid="sol-close">
          Repay everything and take my ZEC home
        </button>
        {grant?.live && (
          <button type="button" className="btn btn-ghost" onClick={onRevoke} disabled={busy} data-testid="sol-revoke">
            Revoke the keeper&rsquo;s permission
          </button>
        )}
      </div>
    </div>
  );
}
