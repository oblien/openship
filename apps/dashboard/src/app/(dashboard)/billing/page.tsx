import { redirect } from "next/navigation";
import { billingTabHref } from "@/lib/billing-links";

export default async function BillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(billingTabHref("overview", await searchParams));
}
