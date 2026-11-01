import { NetworkEditor } from "@/components/servers/clusters/NetworkEditor";

export default async function EditServerClusterPage({
  params,
  searchParams,
}: {
  params: Promise<{ networkId: string }>;
  searchParams: Promise<{ preparation?: string }>;
}) {
  const { networkId: clusterId } = await params;
  const { preparation } = await searchParams;
  return (
    <NetworkEditor
      key={`${clusterId}:${preparation ?? ""}`}
      clusterId={clusterId}
      preparationId={preparation}
    />
  );
}
