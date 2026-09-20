import { redirect } from "next/navigation";
export default async function LegacyNetworkSetup({
  params,
}: {
  params: Promise<{ operationId: string }>;
}) {
  const { operationId } = await params;
  redirect(`/servers/networks/operations/${encodeURIComponent(operationId)}`);
}
