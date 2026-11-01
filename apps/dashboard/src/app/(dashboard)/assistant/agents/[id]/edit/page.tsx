import { redirect } from "next/navigation";
import { agentDrawerHref } from "@/components/assistant/agent-navigation";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(agentDrawerHref(`/assistant/agents/${encodeURIComponent(id)}/edit`));
}
