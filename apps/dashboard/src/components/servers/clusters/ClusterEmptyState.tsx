"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
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
  const n = t.servers.networks;
  const isNetworks = view === "networks";
  const Illustration = isNetworks ? PrivateNetworkIllustration : ServerClusterIllustration;

  return (
    <div className="px-4 py-12 text-center sm:py-16">
      <Illustration className="mb-8" />
      <h2 className="text-2xl font-medium tracking-tight text-foreground/80">
        {isNetworks ? n.networksEmptyTitle : c.listTitle}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground/70">
        {isNetworks
          ? n.networksEmptyDescription
          : canManage
            ? c.listDescription
            : c.managePermissionRequired}
      </p>
      {canManage && (
        <div className="mt-7 flex justify-center">
          <Button asChild size="lg">
            <Link href={isNetworks ? "/servers/networks/new" : "/servers/clusters/new"}>
              <Plus />
              {isNetworks ? n.createCluster : c.createCluster}
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
