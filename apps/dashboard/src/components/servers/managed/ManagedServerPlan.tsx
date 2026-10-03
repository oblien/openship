"use client";

import Link from "next/link";
import type { CloudWorkspaceSummary } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { CapacitySummary } from "@/components/shared/CapacitySummary";
import { workspaceBillingHref } from "@/components/billing/BillingWorkspaceContext";
import type { ManagedServerActions } from "./useManagedServerActions";

export function ManagedServerPlan({
  server,
  actions,
}: {
  server: CloudWorkspaceSummary;
  actions: ManagedServerActions;
}) {
  const { t } = useI18n();
  const copy = t.billing.workspaces;
  const pending = ["queued", "running"].includes(server.operation?.status ?? "");
  const stopped = ["stopped", "paused", "suspended"].includes(server.state);
  const settled = !server.operation || server.operation.status === "succeeded";
  return (
    <section className="space-y-4 rounded-2xl bg-card p-5">
      <h2 className="text-base font-medium">{copy.provisioned}</h2>
      {server.resources && <CapacitySummary resources={server.resources} />}
      <p className="text-sm text-muted-foreground">
        {copy.poolHint}
      </p>
      <Button asChild className="w-full">
        <Link href={workspaceBillingHref("/billing/plans", server.id)}>
          {server.planTierId === "free" ? t.billing.onboarding.choosePlan : copy.changePlan}
        </Link>
      </Button>
      {server.planTierId !== "free" && (
        <>
          {(!server.resources || stopped) && settled && (
            <Button
              variant="secondary"
              className="w-full"
              disabled={actions.busy || pending}
              onClick={() => void actions.ensure()}
            >
              {stopped ? copy.resume : copy.provision}
            </Button>
          )}
          {server.resources && (
            <Button
              variant="secondary"
              className="w-full"
              disabled={actions.busy || pending}
              onClick={() => void actions.previewResize()}
            >
              {copy.resize}
            </Button>
          )}
        </>
      )}
      <Link
        href={workspaceBillingHref("/billing/overview", server.id)}
        className="block text-center text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        {t.dashboard.nav.billing}
      </Link>
    </section>
  );
}
