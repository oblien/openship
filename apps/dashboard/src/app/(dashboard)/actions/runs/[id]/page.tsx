import { RunDetails } from "@/components/actions/RunDetails";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunDetails id={id} />;
}
