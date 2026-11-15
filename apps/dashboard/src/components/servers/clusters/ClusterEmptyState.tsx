"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { FeatureIllustration } from "@repo/ui/illustrations";

import Link from "next/link";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

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

  return (
    <div className="rounded-2xl bg-card px-6 py-10 text-center">
      <FeatureIllustration
        name={isNetworks ? "private-networking" : "server-management"}
        className="illustration-color mx-auto mb-4 h-auto w-20"
      />
      <h2 className="text-xl font-medium tracking-tight text-foreground">
        {isNetworks ? n.networksEmptyTitle : c.listTitle}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {isNetworks
          ? n.networksEmptyDescription
          : canManage
            ? c.listDescription
            : c.managePermissionRequired}
      </p>
      {canManage && (
        <div className="mt-6 flex justify-center">
          <Button asChild>
            <Link href={isNetworks ? "/servers/networks/new" : "/servers/clusters/new"}>
              <UiIcon name="plus" />
              {isNetworks ? n.createCluster : c.createCluster}
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
