"use client";

import { KAMINO_WORDING, SOLANA_DISCLOSURES } from "@/lib/solana/copy";

const RISKS_URL = "https://github.com/mbrobert/ZEC-Defi-App/blob/main/docs/RISKS.md#22--solana-module-bridged-zec-on-kamino";
const PRIVACY_URL = "https://github.com/mbrobert/ZEC-Defi-App/blob/main/docs/PRIVACY.md";

/** The step's title and the first disclosure's title are one string (SOLANA-ARCHITECTURE §8). */
const STEP_TITLE = SOLANA_DISCLOSURES.bridged_zec.title;

/**
 * Step 1 (SOLANA-ARCHITECTURE.md §8): what the user's ZEC on Solana is, in Kamino's own words first and then
 * Oilskin's additions, before any number is shown. One decision: "I have read this."
 */
export default function BridgedZecStep({ acknowledged, onAcknowledge }: { acknowledged: boolean; onAcknowledge: (v: boolean) => void }) {
  const ours = [SOLANA_DISCLOSURES.bridged_zec, SOLANA_DISCLOSURES.kamino_parameters_mutable, SOLANA_DISCLOSURES.usdc_freezable, SOLANA_DISCLOSURES.program_exit_only];
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[19px]">{STEP_TITLE}</h2>
        <p className="mt-1 text-[13.5px] text-oil-ink2">Before any number, what you would be depositing and who can change the rules. Kamino, the lending market this position lives on, says this about the token:</p>
      </div>
      <blockquote className="card border-l-4 border-oil-brass p-4 text-[13.5px] text-oil-ink" data-testid="kamino-wording">
        <p>{KAMINO_WORDING.quote}</p>
        <footer className="mt-2 text-[12px] text-oil-ink3">
          — Kamino, {KAMINO_WORDING.source}, read {KAMINO_WORDING.readAt.slice(0, 10)}.{" "}
          <a className="underline" href={KAMINO_WORDING.learnMore} target="_blank" rel="noreferrer">
            Kamino&rsquo;s &ldquo;learn more&rdquo; link
          </a>
        </footer>
      </blockquote>
      <div className="space-y-3">
        {ours.map((d) => (
          // The first disclosure IS this step's title (SOLANA-ARCHITECTURE §8 names the step after it), so its
          // card carries the body alone — printing the heading twice in a row read as a rendering fault.
          <div key={d.title} className="card p-4">
            {d.title !== STEP_TITLE && <div className="text-[14px] font-semibold">{d.title}</div>}
            <p className={`text-[13px] text-oil-ink2 ${d.title === STEP_TITLE ? "" : "mt-1"}`}>{d.body}</p>
          </div>
        ))}
      </div>
      <p className="text-[12.5px] text-oil-ink3">
        The full list is in{" "}
        <a className="underline" href={RISKS_URL} target="_blank" rel="noreferrer">
          RISKS §22
        </a>{" "}
        and what each party learns about you in{" "}
        <a className="underline" href={PRIVACY_URL} target="_blank" rel="noreferrer">
          PRIVACY §6
        </a>
        .
      </p>
      <label className="flex items-start gap-3 text-[13.5px]">
        <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} data-testid="ack-bridged" />
        <span>I have read what my ZEC on Solana is, that Kamino&rsquo;s market owner can change the rules, that Circle can freeze USDC, and that the way out is through the Oilskin program.</span>
      </label>
    </div>
  );
}
