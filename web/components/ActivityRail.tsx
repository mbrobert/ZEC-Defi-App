import { BASE_CHAIN } from "@zyo/shared";
import { fmtAgo } from "@/lib/format";

export interface ActivityItem {
  at: string;
  kind: string;
  text: string;
  tx?: string;
}

const ICON: Record<string, { glyph: string; cls: string }> = {
  open: { glyph: "＋", cls: "bg-brass/15 text-brass" },
  claim: { glyph: "↓", cls: "bg-status-good/15 text-status-good" },
  rung: { glyph: "▲", cls: "bg-status-warn/15 text-status-warn" },
  rebalance: { glyph: "⇄", cls: "bg-status-info/15 text-status-info" },
  spot: { glyph: "⇆", cls: "bg-status-info/15 text-status-info" },
  unwind: { glyph: "−", cls: "bg-oil-surface2 text-oil-ink2" },
  event: { glyph: "•", cls: "bg-oil-surface2 text-oil-ink2" },
};

export default function ActivityRail({ items, source }: { items: ActivityItem[]; source: "chain" | "cache" | "demo" }) {
  return (
    <div className="card p-5 lg:sticky lg:top-[82px]" data-testid="activity-rail">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px]">Activity</h2>
        <span className="text-[11.5px] text-oil-ink3">{source === "demo" ? "demo" : source === "cache" ? "indexer cache" : "chain"}</span>
      </div>
      <div className="mt-1">
        {items.length === 0 && <div className="py-6 text-center text-[13px] text-oil-ink3">Nothing yet.</div>}
        {items.map((a, i) => {
          const ic = ICON[a.kind] ?? ICON.event;
          return (
            <div key={i} className="act">
              <span className={`act-ic ${ic.cls}`} aria-hidden>
                {ic.glyph}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-oil-ink">{a.text}</div>
                <time className="block text-[12px] text-oil-ink3" dateTime={a.at}>
                  {fmtAgo(a.at)}
                  {a.tx && (
                    <>
                      {" · "}
                      <a className="text-status-info" href={`${BASE_CHAIN.explorerUrl}/tx/${a.tx}`} target="_blank" rel="noreferrer">
                        tx ↗
                      </a>
                    </>
                  )}
                </time>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
