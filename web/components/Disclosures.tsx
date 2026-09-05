import { risksFor, type RiskItem } from "@/lib/copy";

/** The full risk list for a surface (BASE-PIVOT §4 item 19). Always expanded on Review. */
export default function Disclosures({ scope, open = false, title = "Risks you are accepting" }: { scope: RiskItem["scope"][number]; open?: boolean; title?: string }) {
  const items = risksFor(scope);
  return (
    <details className="rounded-xl border border-dashed border-oil-line" open={open} data-testid={`disclosures-${scope}`}>
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[13.5px] font-semibold text-oil-ink2">
        <span>
          {title} <span className="ml-1 text-oil-ink3">({items.length})</span>
        </span>
        <span className="text-oil-ink3">▾</span>
      </summary>
      <ol className="space-y-3 border-t border-white/10 px-4 py-3">
        {items.map((r) => (
          <li key={r.id} className="text-[13px] leading-relaxed text-oil-ink2">
            <span className="font-semibold text-oil-ink">{r.title}.</span> {r.body}
          </li>
        ))}
      </ol>
    </details>
  );
}
