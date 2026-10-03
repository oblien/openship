"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { setActiveOrganizationId } from "@/lib/api/client";
import { useI18n } from "@/components/i18n-provider";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/PageContainer";
import { BillingHeader } from "@/app/(dashboard)/billing/_components/BillingHeader";
import BillingTabSkeleton from "@/app/(dashboard)/billing/_components/BillingTabSkeleton";
import { scopedBillingHref } from "@/lib/billing-links";

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
}: {
  organizationId: string;
  tab: "overview" | "topups";
  workspaceId?: string;
  embedded?: boolean;
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
        window.location.assign(scopedBillingHref(`/billing/${tab}`, { workspaceId, organizationId }));
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [organizationId, tab, workspaceId]);
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
