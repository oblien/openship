import { ManagedNetworkPreparationPage } from "@/components/servers/clusters/ManagedNetworkPreparationPage";

export default async function NetworkPreparationPage({
  params,
}: {
  params: Promise<{ preparationId: string }>;
}) {
  const { preparationId } = await params;
  return <ManagedNetworkPreparationPage key={preparationId} id={preparationId} />;
}
