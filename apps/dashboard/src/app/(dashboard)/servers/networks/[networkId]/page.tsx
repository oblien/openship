import { NetworkDetail } from "@/components/servers/clusters/NetworkDetail";

export default async function ServerClusterPage({
  params,
}: {
  params: Promise<{ networkId: string }>;
}) {
  const { networkId: clusterId } = await params;
  return <NetworkDetail key={clusterId} id={clusterId} />;
}
