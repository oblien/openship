"use client";

import { PageHeader } from "@/components/page-header";

export default function DeploymentsPage() {
  return (
    <>
      <PageHeader pageKey="deployments" />
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No deployments yet. Deploy a project to see history here.
        </p>
      </div>
    </>
  );
}
