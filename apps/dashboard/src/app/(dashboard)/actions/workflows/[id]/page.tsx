import { WorkflowDetails } from "@/components/actions/WorkflowDetails";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkflowDetails id={id} />;
}
