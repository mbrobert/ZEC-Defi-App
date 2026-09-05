import { FEES } from "@zyo/shared";
import { FOOTER_LINES, risksFor } from "@/lib/copy";

export default function Footer() {
  const risks = risksFor("footer");
  return (
    <footer className="mt-10 border-t border-white/10 py-6 text-[12.5px] text-oil-ink3">
      <div className="mx-auto max-w-[1180px] space-y-2 px-4 sm:px-6">
        {FOOTER_LINES.map((l) => (
          <p key={l}>{l}</p>
        ))}
        <p>
          Performance fee {FEES.performanceBps / 100}% of realised yield (on-chain cap {FEES.maxPerformanceBps / 100}%); no orchestration fee in v1.
        </p>
        <details>
          <summary className="cursor-pointer text-oil-ink2">Risks in one paragraph each ({risks.length})</summary>
          <ul className="mt-2 space-y-1.5">
            {risks.map((r) => (
              <li key={r.id}>
                <b className="text-oil-ink2">{r.title}.</b> {r.body}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </footer>
  );
}
