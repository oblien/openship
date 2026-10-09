import { RunnerEditor } from "@/components/actions/RunnerEditor";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunnerEditor id={id} />;
}
