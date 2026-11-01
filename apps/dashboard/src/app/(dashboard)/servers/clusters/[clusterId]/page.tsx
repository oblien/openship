import { ClusterDetail } from "@/components/servers/clusters/ClusterDetail";
import { redirect } from "next/navigation";
export default async function ServerClusterPage({
  params,
  searchParams,
}: {
  params: Promise<{ clusterId: string }>;
  searchParams: Promise<{ from?: string; tab?: string }>;
}) {
  const { clusterId } = await params;
  const { from, tab } = await searchParams;
  if (from === "networking" || tab === "network")
    redirect(`/servers/networks/${encodeURIComponent(clusterId)}`);
  return <ClusterDetail key={clusterId} id={clusterId} />;
}
