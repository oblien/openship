import { ManagedNetworkOperationPage } from "@/components/servers/clusters/ManagedNetworkOperationPage";

export default async function NetworkOperationPage({
  params,
}: {
  params: Promise<{ operationId: string }>;
}) {
  const { operationId } = await params;
  return <ManagedNetworkOperationPage key={operationId} id={operationId} />;
}
