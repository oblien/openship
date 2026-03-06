"use client";

import { PageHeader } from "@/components/page-header";

export default function DomainsPage() {
  return (
    <>
      <PageHeader pageKey="domains" />
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No custom domains configured. Add a domain to get started.
        </p>
      </div>
    </>
  );
}
