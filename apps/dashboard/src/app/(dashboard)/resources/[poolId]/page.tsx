"use client";

import { use } from "react";
import { ManagedResourcesPage } from "@/components/resources/ManagedResourcesPage";

export default function ResourcePoolPage({ params }: { params: Promise<{ poolId: string }> }) {
  const { poolId } = use(params);
  return <ManagedResourcesPage serverId={poolId} />;
}
