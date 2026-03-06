"use client";

import { PageHeader } from "@/components/page-header";

export default function MonitoringPage() {
  return (
    <>
      <PageHeader pageKey="monitoring" />
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No active services to monitor.
        </p>
      </div>
    </>
  );
}
