"use client";

import { PageHeader } from "@/components/page-header";

export default function SettingsPage() {
  return (
    <>
      <PageHeader pageKey="settings" />
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Settings will appear here.
        </p>
      </div>
    </>
  );
}
