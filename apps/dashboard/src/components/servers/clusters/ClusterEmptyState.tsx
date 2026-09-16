"use client";

import Link from "next/link";
import { ArrowRight, Plus } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import {
  PrivateNetworkIllustration,
  ServerClusterIllustration,
} from "@/components/servers/InfrastructureIllustrations";

export function ClusterEmptyState({
  view,
  canManage,
}: {
  view: "clusters" | "networks";
  canManage: boolean;
}) {
  const { t } = useI18n();
  const c = t.servers.clusters;
  const isNetworks = view === "networks";
  const Illustration = isNetworks ? PrivateNetworkIllustration : ServerClusterIllustration;

  return (
    <div className="px-4 py-12 text-center sm:py-16">
      <Illustration className="mb-8" />
      <h3 className="text-2xl font-medium tracking-tight text-foreground/80">
        {isNetworks ? c.networksEmptyTitle : c.emptyTitle}
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground/70">
        {isNetworks
          ? c.networksEmptyDescription
          : canManage
            ? c.emptyDescription
            : c.managePermissionRequired}
      </p>
      {(isNetworks || canManage) && (
        <div className="mt-7 flex justify-center">
          <Button asChild size="lg">
            <Link href={isNetworks ? "/servers?tab=cluster" : "/servers/clusters/new"}>
              {!isNetworks && <Plus />}
              {isNetworks ? c.viewClusters : c.createCluster}
              {isNetworks && <ArrowRight className="rtl:rotate-180" />}
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
