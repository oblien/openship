import { redirect } from "next/navigation";
export default async function LegacyNetworkSetup({
  params,
}: {
  params: Promise<{ preparationId: string }>;
}) {
  const { preparationId } = await params;
  redirect(`/servers/networks/preparations/${encodeURIComponent(preparationId)}`);
}
