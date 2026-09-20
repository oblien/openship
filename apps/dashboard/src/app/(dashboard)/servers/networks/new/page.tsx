import { NetworkEditor } from "@/components/servers/clusters/NetworkEditor";

export default async function NewServerClusterPage({
  searchParams,
}: {
  searchParams: Promise<{ preparation?: string }>;
}) {
  const { preparation } = await searchParams;
  return <NetworkEditor key={preparation} preparationId={preparation} />;
}
