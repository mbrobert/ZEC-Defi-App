/**
 * `next dev` compiles a route the first time it is requested, and a cold
 * compile in this container can take longer than a per-assertion timeout —
 * which made the first test of a run fail on a slow machine while every later
 * one passed. That is a harness artefact, not a product defect, so warm every
 * route once before the suite instead of loosening the timeouts that protect
 * the real assertions.
 */
const ROUTES = ["/", "/onboard", "/new", "/dashboard", "/spot"];

export default async function globalSetup(): Promise<void> {
  const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:3111").replace(/\/$/, "");
  for (const r of ROUTES) {
    try {
      const res = await fetch(`${base}${r}`, { signal: AbortSignal.timeout(120_000) });
      await res.text();
    } catch {
      // The suite's own assertions will report a route that is genuinely broken.
    }
  }
}
