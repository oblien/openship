import { ClusterEditor } from "@/components/servers/clusters/ClusterEditor";
import { redirect } from "next/navigation";
export default async function EditServerClusterPage({
  params,
  searchParams,
}: {
  params: Promise<{ clusterId: string }>;
  searchParams: Promise<{ preparation?: string; from?: string }>;
}) {
  const { clusterId } = await params;
  const { preparation, from } = await searchParams;
  if (preparation || from === "networking")
    redirect(
      `/servers/networks/${encodeURIComponent(clusterId)}/edit${preparation ? `?preparation=${encodeURIComponent(preparation)}` : ""}`,
    );
  return <ClusterEditor key={clusterId} id={clusterId} />;
}
