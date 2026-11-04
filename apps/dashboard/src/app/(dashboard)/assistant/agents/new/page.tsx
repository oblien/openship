import { redirect } from "next/navigation";
import { agentDrawerHref } from "@/components/assistant/agent-navigation";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ template?: string; project?: string }>;
}) {
  const { template, project } = await searchParams;
  const params = new URLSearchParams();
  if (template) params.set("template", template);
  if (project) params.set("project", project);
  redirect(agentDrawerHref(`/assistant/agents/new?${params}`));
}
