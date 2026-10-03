import type { IconName } from "@repo/ui/icons";

export type BillingTab = "overview" | "usage" | "plans" | "topups" | "payment" | "invoices";

export const BILLING_TABS: Array<{ key: BillingTab; href: string; icon: IconName }> = [
  { key: "overview", href: "/billing/overview", icon: "dashboard" },
  { key: "usage", href: "/billing/usage", icon: "chart-bar" },
  { key: "plans", href: "/billing/plans", icon: "star" },
  { key: "topups", href: "/billing/topups", icon: "coins" },
  { key: "payment", href: "/billing/payment", icon: "credit-card" },
  { key: "invoices", href: "/billing/invoices", icon: "receipt" },
];
