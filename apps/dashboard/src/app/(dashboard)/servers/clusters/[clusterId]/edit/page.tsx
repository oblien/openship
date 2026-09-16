import { ClusterEditor } from "@/components/servers/clusters/ClusterEditor";

export default async function EditServerClusterPage({
  params,
}: {
  params: Promise<{ clusterId: string }>;
}) {
  const { clusterId } = await params;
  return <ClusterEditor key={clusterId} clusterId={clusterId} />;
}
