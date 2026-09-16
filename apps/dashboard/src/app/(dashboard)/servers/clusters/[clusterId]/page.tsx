import { ClusterDetail } from "@/components/servers/clusters/ClusterDetail";

export default async function ServerClusterPage({
  params,
}: {
  params: Promise<{ clusterId: string }>;
}) {
  const { clusterId } = await params;
  return <ClusterDetail key={clusterId} id={clusterId} />;
}
