/** Mail products available at checkout and the placements a mailbox service can occupy. */
export const PAID_MAIL_PLANS = ["solo", "team", "business", "scale"] as const;
export type PaidMailPlan = (typeof PAID_MAIL_PLANS)[number];

export const MAIL_PRODUCTS = ["mailboxes", "dedicated", "sending"] as const;
export type MailProduct = (typeof MAIL_PRODUCTS)[number];

export const MAIL_PLACEMENTS = ["standard", "dedicated"] as const;
export type MailPlacement = (typeof MAIL_PLACEMENTS)[number];

export const MAIL_PRODUCT_ICONS = {
  mailboxes: "mail",
  dedicated: "server",
  sending: "code",
} as const;

export function parseMailProduct(value: unknown): MailProduct | undefined {
  return MAIL_PRODUCTS.find((product) => product === value);
}

export interface MailStorageOption {
  storageGB: number;
  vmMonthlyCents: number;
}
export function dedicatedMailMonthlyCents(vmMonthlyCents: number, sendingMonthlyCents: number) {
  return vmMonthlyCents + sendingMonthlyCents;
}

export function mailTierPrice(
  tier: { monthlyCents: number; sendingMonthlyCents: number },
  product: MailProduct,
  storage?: MailStorageOption,
) {
  if (product === "dedicated") {
    if (!storage) throw new Error("Dedicated mail requires a storage option");
    return dedicatedMailMonthlyCents(storage.vmMonthlyCents, tier.sendingMonthlyCents);
  }
  return product === "sending" ? tier.sendingMonthlyCents : tier.monthlyCents;
}

/** The public site and the mail console enter the same billing product. */
export function emailPlansHref(
  plan?: string | null,
  organizationId?: string | null,
  product?: MailProduct,
  storageGB?: number,
) {
  const query = new URLSearchParams({ product: "email" });
  if (plan && PAID_MAIL_PLANS.some((value) => value === plan)) query.set("mailPlan", plan);
  if (product) query.set("mailProduct", product);
  if (product === "dedicated" && storageGB && Number.isSafeInteger(storageGB) && storageGB > 0)
    query.set("storageGB", String(storageGB));
  if (organizationId) query.set("organizationId", organizationId);
  return "/billing/plans?" + query;
}

export function changeMailPlanHref(target: string, organizationId?: string | null) {
  return emailPlansHref(null, organizationId) + "&changeMail=" + encodeURIComponent(target);
}
