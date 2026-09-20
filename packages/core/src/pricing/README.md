# Application plan limits and legacy pricing

Cloud checkout, prices, credit allowances, and packs come from Oblien's live
billing catalog. The API, dashboard (including linked local instances), and
marketing site use that catalog. Do not configure new Cloud prices or credit
grants through Stripe or the historical values in `pricing.json`.

`planLimits(tier)` still defines Openship application permissions such as project
counts and build-minute limits. Stable app IDs map to provider IDs in
`packages/platform/src/engine/modules/billing/billing-catalog.ts`:
`starter → hobby`, `pro → pro`, `team → scale`. Provider currency amounts are
converted to cents, and provider credits to milli-credits, at that boundary.

This directory also contains shared UI copy, the free self-hosted offer, and
historical pricing helpers needed by older data/clients. The reference below
describes those application definitions, not the current provider price list.
See [the Cloud release gate](../../../../docs/openship-cloud-launch.md) for
provider configuration and migration requirements.

## Changing a limit

Every numeric limit uses **`null` = unlimited**, everywhere, with no exceptions.

```jsonc
"limits": {
  "workloads": ["static"],       // WorkloadType[] — "static" | "web" | "worker"
  "services": false,             // Compose stacks, catalog apps, managed databases
  "runningServices": 0,          // concurrent services; Compose containers also count
  "maxProjects": 0,
  "maxResourceTier": "low",      // largest per-service machine, in the wizard's own tier names
  "computeMinutesPerMonth": 0,   // app runtime, in `low`-machine minutes (0 = no Cloud runtime)
  "buildMinutesPerMonth": 0,
  "freeSubdomains": 10,          // *.opsh.io routes
  "customDomains": null,
  "seats": null                  // null on every tier — we never charge per seat
}
```

### What separates one tier from the next

Five numbers and a support level: **compute minutes, build minutes, machine size, projects, running
services.** Nothing else. Paid tiers share capabilities. An account without a Cloud plan has
zero project, build-minute and running-service allowances; self-hosted projects remain unmetered.

This is a rule about honesty, not taste. The bullets used to be the differentiator and they were
differentiating on nothing enforced: Pro sold a "Built-in mail server" while `mail.controller.ts`
404s every mail route under `CLOUD_MODE`; Starter sold "Preview deploys on every push", which is not
built; Scale sold an "Audit log with extended retention" that every tier already has ungated. Anything
true on every tier now lives once in `standard.features`, and only if it actually ships on cloud.

Two tests hold the line: *"differentiates tiers on usage and size, not on capability"* and
*"retires the copy for capabilities cloud does not sell"*.

### Compute minutes

One compute minute is **one minute of a `low` machine**. Larger machines burn a multiple, derived from
`RESOURCE_TIER_SPECS` by `computeUnitsPerMinute()` — `medium` 2×, `high` 4×, `xlarge` 8× — so one
published allowance covers every size.

The legacy compute-minute helper covers its app cap over a 43,200-minute month, so
Scale's 50 apps need 2,160,000 and it ships 2,200,000. A test enforces it
(*"includes enough compute to run a tier's whole app cap around the clock"*). This is not a guarantee
of Cloud runtime: Oblien's current catalog credit grant and measured resource costs determine how
long customer workloads can run. Billing does not convert those credits into promised runtime hours.

### Why build minutes are generous

They cost us almost nothing and they are the number customers compare. One build minute is 4
vCPU-minutes — roughly **$0.0005** at commodity rates — and Vercel meters the same 4 vCPU / 8 GB
standard build machine at **$0.014/minute**, a ~30× markup. Their Pro plan is $20/seat with a $20
credit, so a customer spending the whole credit on builds gets ~1,428 minutes (~71 per dollar); Starter
ships 3,000 for $10 (300 per dollar). Being stingy here saved us cents and lost the comparison, so if
you tune anything, tune build minutes UP.

This replaced an authored `credits` blob. Its numbers (500/2k/10k/60k) meant nothing measurable —
Scale advertised 50 running services on a budget that could not run **one** app around the clock — and
`billing-credit-units.ts` admitted as much in a comment. The legacy helper derives an allowance:

```
planMonthlyCredits() = (computeMinutesPerMonth + buildMinutesPerMonth × buildMultiplier) × 1000
```

Current Cloud billing uses the provider's credit grant, not this formula. Free Cloud accounts have
zero projects, build minutes, runtime and provider credits. Positive-credit conversion helpers must
not be used to grant a no-plan customer free usage.

Cloud top-up packs also come from the provider catalog. Billing shows each pack's price and its
size relative to the customer's included usage; exact credits are available under Usage details.
There is no assumed conversion of one credit to one compute minute.

**The rule this file exists to enforce: never publish a number nothing enforces.** Every limit above
is either enforced by Oblien (`resource_limits`, credit quota) or by a gate in
`packages/platform/src/engine/lib/plan-guard.ts`. The legacy `bandwidthGb` field is not part of these
application limits. Edge traffic now has its own provider-enforced monthly allowance, documented at
https://oblien.com/docs/concepts/limits and mapped by the Cloud billing catalog: Hobby 50 GB, Pro
500 GB, Scale 2,000 GB and Enterprise uncapped. Openship's no-plan tier includes zero Cloud traffic.
The billing resources endpoint measures namespace-scoped edge requests and bandwidth for the period.
Compute transfer remains part of the compute credit allowance; it is not interchangeable with Edge
traffic. No separate numeric request allowance is published by the provider.

### Why Oblien's ceilings are derived, not authored

Oblien takes `{max_workspaces, max_vcpus, max_ram_mb, max_disk_gb}` per namespace, and **three of
those four are per-WORKSPACE caps** — only `max_workspaces` is namespace-wide. Authoring them directly
gave us "Pro: 16 vCPU" on the page while permitting 16 × 10 = 160, in sizes no picker offered. So
`toOblienLimits()` derives them:

| Oblien field | derived from |
|---|---|
| `max_workspaces` | `runningServices` + `oblien.buildWorkspaceHeadroom` |
| `max_vcpus` / `max_ram_mb` / `max_disk_gb` | **max** of the tier's `maxResourceTier` spec and `oblien.buildResources` |

That max is load-bearing: a build gets its own workspace, so a ceiling below the build machine means
Oblien **409s every build**. Free published 2 vCPU / 2 GB against a 4 vCPU / 8 GB build, which would
have broken every free deploy the moment ceilings went live.

A consequence to expect: because the build machine dominates, `max_vcpus`/`max_ram_mb` come out
identical on every tier. Oblien cannot tell a build workspace from a runtime one, so it physically
cannot both fit a build and cap a service. **Oblien is the coarse backstop; the per-service size cap
is enforced by `assertPlanAllowsResourceTier`** where the machine is chosen. Equal ceilings are not a
bug.

## Running a discount campaign

`campaigns[]` holds time-bounded automatic discounts — no code typed, applied to everyone.

```jsonc
{
  "id": "launch50",
  "percentOff": 50,
  "appliesTo": "all",                        // or ["pro","team"]
  "startsAt": "2026-09-01T00:00:00Z",
  "endsAt":   "2026-09-30T23:59:59Z",        // full ISO instant WITH offset — required
  "durationMonths": 3,                       // null = subscription lifetime
  "stripeCouponEnv": "STRIPE_COUPON_LAUNCH50"
}
```

1. Create the coupon in Stripe (`percent_off` **must equal** `percentOff`, duration must match
   `durationMonths`) and set the env var the campaign names.
2. Add the entry, run the tests.

Things the schema and the boot check already stop you doing: a bare `"2026-09-30"` date (ambiguous
between UTC and local, and it ends a day early), two campaigns overlapping on one plan, a window that
ends before it starts, targeting a plan that doesn't exist, and — via `verifyCampaigns()` at boot — a
catalog that says 50% while the coupon gives 40%.

Two behaviours to know:

- **The promo-code box disappears while a campaign runs.** Stripe rejects a Checkout Session carrying
  both an automatic discount and a redeemable code field, so codes minted by
  `apps/api/scripts/promo-code.ts` cannot be redeemed during a campaign. Run `promo-code.ts list`
  first, and make the campaign at least as generous as anything outstanding.
- **`now` is always an argument.** `activeCampaign(planId, now)` and
  `effectiveMonthlyPrice(planId, now)` never read a module-level clock, because this file is imported
  into browser bundles and into a prerendered page — anything evaluated at module scope freezes at
  build time and could never expire.

## Changing copy

`plans.<id>.name` / `.tagline` and the `features.*` strings live in `locales/<lang>.json`. A feature
bullet is referenced **by key** from `pricing.json#plans[].features`, and that array's order is the
display order — so reordering or dropping a bullet is a `pricing.json` edit, while rewording it is a
locale edit.

Feature strings interpolate `{placeholders}` resolved from that plan's own limits, so a number is
stated **once** in `pricing.json` and every language picks it up:

`{computeMinutes}` `{buildMinutes}` `{runningServices}` `{maxProjects}` `{freeSubdomains}`
`{customDomains}` `{seats}` `{powerCpu}` `{powerRamGb}` `{powerDiskGb}` `{inherited}`
`{freeDomainSuffix}`

Counts are formatted for the reader's locale (`60,000` / `60.000`). Arabic is pinned to Latin
numerals to match the rest of the product.

Adding a language: drop `locales/<code>.json` in, add the code to `PRICING_LOCALES` in `index.ts`,
and keep it in step with the dashboard's locale list — the test fails if the two diverge, because a
translated dashboard next to English prices is worse than either.

## What the test enforces

Beyond shape: that `PlanTierId` still matches the catalog's ids, that the ladder is monotonic (a
pricier tier can never have a smaller allowance), that **each paid tier is better value per dollar
than the one below it**, that no tier charges per seat, that every credit grant stays under Oblien's
10,000,000-credit ceiling, that an unknown `plan_tier_id` falls back to the *most restrictive* tier
rather than opening a gate, and — for translations — full key parity, matching placeholder sets, and
no string left in English.
