// No DOM needed: renderToStaticMarkup runs no effects and both subjects are pure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { PLANS, pricingUi } from "@repo/core";
import { BillingSidebar } from "./billing-shared";
import { PricingCards, type ApiPlan } from "@/components/billing/PricingCards";
import type { BillingState } from "@/lib/api/billing";

function render(node: React.ReactElement) {
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
}

function text(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const state = (tier: BillingState["tier"]): BillingState =>
  ({ tier, status: "active", monthlyCreditLimit: 4_000_000 }) as unknown as BillingState;

/**
 * The billing Overview used to state the plan TWICE — the left card carried the
 * name, the status pill and an upgrade button, and the right column repeated the
 * name, the price, the status and a SECOND upgrade button naming a different tier.
 * The itemised entitlements, meanwhile, were a wrapped hedge of pills in the left
 * card. This pins the split: identity + CTA on the left, the list on the right.
 */
describe("billing sidebar — what's included", () => {
  it("lists the tier's entitlements instead of restating the plan", () => {
    const out = text(render(<BillingSidebar state={state("starter")} />));
    expect(out).toContain("What's included");
    // Every catalog bullet for the tier reaches the column.
    for (const feature of PLANS.starter.features) {
      expect(out, feature).toContain(feature);
    }
  });

  it("carries no second upgrade button", () => {
    // Two panels each offering an upgrade — and naming different tiers — is the
    // defect this replaced. The CTA now lives once, on the left-hand card.
    const out = render(<BillingSidebar state={state("free")} />);
    expect(out).not.toMatch(/Upgrade to/i);
    expect(out).not.toContain("/billing/plans");
  });

  it("names the plan once, as the subtitle of the list", () => {
    const out = text(render(<BillingSidebar state={state("pro")} />));
    expect(out).toContain("Pro Plan");
    // The lead-in resolves as prose, not as a ticked feature (see `inheritedFrom`).
    expect(out).toContain("Everything in Starter, plus:");
  });
});

// The catalog's real strings rather than a hand-rolled stub: the endpoint serves
// exactly this block, so the fixture can't drift from what the component receives.
const ui = pricingUi("en");

const plan = (id: string, monthly: number | null): ApiPlan =>
  ({
    id,
    name: id,
    description: "",
    popular: false,
    price: { monthly, annual: null },
    listPrice: { monthly },
    effectivePrice: { monthly },
    campaign: null,
    limits: PLANS.starter.limits,
    features: [],
    support: "email",
  }) as unknown as ApiPlan;

describe("plans grid width", () => {
  it("uses exactly as many columns as there are cards", () => {
    // Pinned at `xl:grid-cols-5` while the catalog happened to publish five cards;
    // dropping the $0 tier left five tracks for four cards and a column of dead
    // space on the right.
    const four = render(
      <PricingCards
        plans={[plan("starter", 1000), plan("pro", 3900), plan("team", 9900), plan("enterprise", null)]}
        ui={ui}
      />,
    );
    expect(four).toContain("xl:grid-cols-4");
    expect(four).not.toContain("xl:grid-cols-5");

    const five = render(
      <PricingCards
        plans={[
          plan("free", 0),
          plan("starter", 1000),
          plan("pro", 3900),
          plan("team", 9900),
          plan("enterprise", null),
        ]}
        ui={ui}
      />,
    );
    expect(five).toContain("xl:grid-cols-5");
  });
});
