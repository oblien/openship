"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { setActiveOrganizationId } from "@/lib/api/client";
import { useI18n } from "@/components/i18n-provider";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/PageContainer";
import { BillingHeader } from "@/app/(dashboard)/billing/_components/BillingHeader";
import BillingTabSkeleton from "@/app/(dashboard)/billing/_components/BillingTabSkeleton";
import { newServerBillingHref, scopedBillingHref } from "@/lib/billing-links";
import type { BillingTab } from "@/app/(dashboard)/billing/_components/billing-tabs";

const organizations = (
  authClient as unknown as {
    organization: {
      setActive: (input: {
        organizationId: string;
      }) => Promise<{ error?: { message?: string } | null }>;
    };
  }
).organization;

/** A billing email must never silently open checkout for a different active org. */
export function CloudBillingLink({
  organizationId,
  tab,
  workspaceId,
  embedded = false,
  newServer = false,
  purchase,
}: {
  organizationId: string;
  tab: BillingTab;
  workspaceId?: string;
  embedded?: boolean;
  newServer?: boolean;
  purchase?: Parameters<typeof newServerBillingHref>[1];
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    if (!organizationId || organizationId.length > 255 || (workspaceId?.length ?? 0) > 255) {
      setFailed(true);
      return;
    }
    void organizations
      .setActive({ organizationId })
      .then((result) => {
        if (disposed) return;
        if (result.error) {
          setFailed(true);
          return;
        }
        setActiveOrganizationId(organizationId);
        window.location.assign(newServer ? newServerBillingHref(organizationId, purchase) : scopedBillingHref(`/billing/${tab}`, { workspaceId, organizationId }));
      })
      .catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/components/billing/CloudBillingLink");
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [organizationId, tab, workspaceId, newServer, purchase]);
  const content = failed ? (
    <div role="alert" className="space-y-4 rounded-2xl bg-card p-5">
      <p className="text-sm text-muted-foreground">{t.billing.creditAlert.wrongOrganization}</p>
      <Button asChild variant="secondary"><Link href="/billing">{t.billing.creditAlert.backToBilling}</Link></Button>
    </div>
  ) : <BillingTabSkeleton />;

  return embedded ? content : (
    <PageContainer className="space-y-6">
      <BillingHeader />
      {content}
    </PageContainer>
  );
}
