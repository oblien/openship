import { redirect } from "next/navigation";
import { assistantDrawerHref } from "@/components/assistant/assistant-navigation";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ template?: string; project?: string }>;
}) {
  const { template, project } = await searchParams;
  const params = new URLSearchParams();
  if (template) params.set("template", template);
  if (project) params.set("project", project);
  redirect(assistantDrawerHref(`/assistant/agents/new?${params}`));
}
