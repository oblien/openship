"use client";

import { PageHeader } from "@/components/page-header";

export default function BillingPage() {
  return (
    <>
      <PageHeader pageKey="billing" />
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Billing and subscription management will appear here.
        </p>
      </div>
    </>
  );
}
