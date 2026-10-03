// No DOM needed: renderToStaticMarkup runs no effects and both subjects are pure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { PLANS, pricingUi } from "@repo/core";
import { BillingSidebar } from "./billing-shared";
import { PricingCards, type ApiPlan } from "@/components/billing/PricingCards";
import type { BillingState } from "@/lib/api/billing";
import { baseDictionary } from "@/i18n";

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
  ({
    tier, status: "active", monthlyCreditLimit: 1_200_000,
    subscription: tier === "free" ? null : { tier, status: "active", interval: "monthly", currentPeriod: { start: null, end: null }, cancelAtPeriodEnd: false, canceledAt: null },
    balance: { total: 0, quotaLimit: 0, quotaUsed: 0, quotaRemaining: 0, unlimited: false },
    billing: { enabled: true },
    plan: tier === "free" ? null : {
      ...PLANS[tier], monthlyCredits: 1_200_000,
      name: "Live Cloud plan", price: { monthly: 1700, annual: 17000 },
      features: ["Support from the live catalog"],
    },
  }) as unknown as BillingState;

describe("billing sidebar", () => {
  it("shows the paid plan's live price with access to the full comparison", () => {
    const html = render(<BillingSidebar state={state("starter")} />);
    const out = text(html);
    expect(out).toContain("Current plan");
    expect(out).toContain("Live Cloud plan");
    expect(out).toContain("$17");
    expect(html).toContain('href="/billing/plans"');
    expect(out).not.toContain("$10");
  });

  it("keeps the no-plan promotion visible when the provider has no free product", () => {
    const out = render(<BillingSidebar state={state("free")} />);
    expect(text(out)).toContain("Launch on Openship Cloud");
    expect(out).toContain("/billing/plans");
    expect(text(out)).not.toContain("Unlimited");
  });

  it("does not invent a price when the paid plan is absent from the response", () => {
    const out = text(render(<BillingSidebar state={{ ...state("pro"), plan: null }} />));
    expect(out).toContain("Change plan");
    expect(out).not.toContain("$39");
    expect(out).not.toContain("credits / billing cycle");
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

describe("custom plan presentation", () => {
  it("keeps the catalog's sales action and current-plan state without promising preset allowances", () => {
    const custom = {
      ...plan("enterprise", null),
      name: "Enterprise",
      description: "Limits tailored to your team.",
      contactSales: "https://sales.example.test/contact",
      limits: PLANS.enterprise.limits,
    };
    const offer = render(<PricingCards plans={[custom]} ui={ui} />);
    expect(text(offer)).toContain(custom.description);
    expect(text(offer)).toContain(ui.custom);
    expect(offer).toContain(`href="${custom.contactSales}"`);
    expect(text(offer)).toContain(ui.ctaContact);
    expect(text(offer)).not.toContain("No set limit");
    expect(text(offer)).not.toContain("Choose Enterprise");

    const current = render(<PricingCards plans={[custom]} ui={ui} currentPlan="enterprise" />);
    expect(text(current)).toContain("Current plan");
    expect(current).not.toContain(`href="${custom.contactSales}"`);
  });
});

describe("plan comparison", () => {
  it("shows benefits and places the shared usage explanation once after every plan", () => {
    const plans = (["hobby", "starter", "pro", "team"] as const).map((id) => ({
      ...PLANS[id], features: [...PLANS[id].features], resourceLimits: PLANS[id].oblienLimits,
      listPrice: { monthly: PLANS[id].price.monthly }, effectivePrice: { monthly: PLANS[id].price.monthly }, campaign: null,
    }));
    const out = render(<PricingCards plans={plans} ui={ui} />);
    const cards = [...out.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)].map(([card]) => text(card));
    const copy = baseDictionary.billing.resourcesGuide;
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(card).toContain(copy.buildTime);
      expect(card).toContain(copy.buildIncluded);
      expect(card).not.toMatch(/credits|Shared across|More features/i);
    }
    expect(out.match(/<details/g)).toHaveLength(1);
    expect(text(out)).toContain("Priority support");
    expect(text(out).split(copy.poolNote)).toHaveLength(2);
    expect(out.indexOf('role="note"')).toBeGreaterThan(out.lastIndexOf("</article>"));
    expect(text(out)).toContain("Hobby : 400");
    expect(text(out)).toContain("Scale : 9,000");
  });
});
