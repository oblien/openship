import { ClusterEditor } from "@/components/servers/clusters/ClusterEditor";
import { redirect } from "next/navigation";
export default async function NewServerClusterPage({
  searchParams,
}: {
  searchParams: Promise<{ networkId?: string; preparation?: string }>;
}) {
  const { networkId, preparation } = await searchParams;
  if (preparation) redirect(`/servers/networks/new?preparation=${encodeURIComponent(preparation)}`);
  return <ClusterEditor key={networkId} networkId={networkId} />;
}
