# UX teardown — Aerodrome · Curve · Convex · Morpho · Pendle → ZYO decisions

Purpose: extract what the five reference apps do well and badly, and bind every
lesson to a concrete, testable decision for the ZEC Yield Orchestrator UI.
(Facts current as of Aug 2026: Curve shipped Llamalend v2; Morpho is being
embedded into mainstream retail apps; Pendle discontinued its separate
simplified "Earn UI" to focus on one product.)

## Aerodrome (aerodrome.finance)

**Well:** the strongest visual identity in DeFi — one dark ground, one signal
color, aviation motif carried everywhere; dense pool tables that stay scannable
(pair icons, APR, TVL, volume, one clear per-row CTA); stepped flows for
lock/vote mechanics; disciplined number formatting.
**Badly:** newcomer hostility — epochs/votes/bribes jargon on first paint;
value invisible until a wallet connects; APRs shown context-free; cramped on
mobile.
**→ ZYO:** one dark ground + one brand accent (ZEC gold), used with Aerodrome's
discipline. Pool list = iconic pairs, APR, TVL, one CTA. But: the app must be
fully legible logged-out (live demo data, "connect to act"), and every APR gets
context (source breakdown + range preset consequence).

## Curve (curve.finance, Llamalend v2)

**Well:** honest, information-dense pro surfaces; Llamalend's *health band*
visualization — your position shown against the soft-liquidation price RANGE,
not a context-free "health: 1.8" — is the best risk display in lending; real
risk parameters exposed, not hidden.
**Badly:** the legacy UI is the canonical example of intimidating DeFi (tiny
type, cluttered panels); years of old/new surface inconsistency; jargon (A
parameter, EMA oracle) unexplained.
**→ ZYO:** adopt the band idea: the health gauge shows the SAFE→WARN→CRITICAL
zones with the exact liquidation price and current ZEC price on one scale —
users see *distance to danger*, not an abstract number. One design system
across prototype, web app, and docs — no surface drift.

## Convex (convexfinance.com)

**Well:** single-purpose clarity; itemized yield ("base + CRV + CVX") that
teaches users where money comes from; claim-everything-at-once.
**Badly:** visually frozen in 2021; tables with no hierarchy; zero onboarding
or risk explanation; static numbers that feel stale.
**→ ZYO:** itemize yield per position — LP fees + incentives, shown NET of the
engine's 15% performance fee (printing the fee builds trust; hiding it breaks
it). Claim/compound-all action. Every live figure carries a freshness stamp
("as of 12s ago") so the dashboard never feels stale.

## Morpho (app.morpho.org)

**Well:** the design benchmark — calm, generous spacing, immaculate dark
theme; a deposit is 2–3 decisions ending in a clean review sheet; skeleton
loading everywhere; simple enough that mainstream retail apps embed it
unchanged.
**Badly:** occasionally *too* minimal — advanced data buried; curator trust
asserted rather than explained.
**→ ZYO:** Morpho calm is the baseline register for Simple mode: few decisions,
review sheet before any commit. Where Morpho under-explains, we over-explain:
the review sheet enumerates every parameter, fee, and risk in plain language.

## Pendle (app.pendle.finance)

**Well:** made the hardest primitive in DeFi legible with live projections —
change an input, see projected outcome instantly; APY charts and maturity
timelines; tooltips that teach rather than define.
**Badly:** still a jargon wall (PT/YT) at the door; and the strategic lesson —
Pendle ran a separate simplified "Earn UI" and killed it: two apps split focus,
and the simple one hid too much to be trusted with real size.
**→ ZYO:** live projection is the wizard's spine — amount, borrow asset, LTV
(loan-to-value), pool, and range preset update a projected APY / health factor
/ liquidation price panel in real time (lib/estimates.ts math). And the
strategic call: ONE app with progressive disclosure (an "advanced" expander for
range width/rebalance delay), never a separate simple app.

## Cross-cutting ZYO decisions (the checklist the build is graded against)

1. **Palette:** near-black warm charcoal ground; ZEC gold `#F4B728` is the only
   brand accent; green/amber/red reserved exclusively for health semantics —
   gold never signals success or danger, so the brand stays unambiguous.
2. **Wizard = 4 steps:** Amount+Mode → Strategy (borrow asset, LTV, pool) →
   Range+Rewards → Review. Right-rail projection updates on every input.
   Review sheet: all parameters, all fees (0.2%→0% 1-Click, 15% engine
   performance fee), all risks, one confirm.
3. **Dashboard:** portfolio header (total value, net APY, ZEC price); position
   cards with the health *band* gauge; itemized net yield; inline
   claim/compound; range status.
4. **First-class states most DeFi apps botch** — ours are engine-verified
   behaviors, so the UI owns them: the 60s deposit/partial-withdraw cooldown
   (countdown chip + "flash-loan protection, retries itself" copy); NEAR
   Intents bridge-in-transit (step timeline ZEC→NEAR→Base); out-of-range
   (amber, "auto-rebalances in ~Xh" from the user's own rebalanceDelay);
   health bands with exact liquidation price.
5. **Numbers:** tabular numerals, dual native+USD display, consistent
   precision, freshness stamps.
6. **Logged-out = full experience** with demo data; connecting only unlocks
   actions.
7. **Plain language:** "range width," not ticks; presets named
   Conservative/Moderate/Aggressive with the % band and its consequence spelled
   out ("tighter range → more fees while in range, rebalances more often").
