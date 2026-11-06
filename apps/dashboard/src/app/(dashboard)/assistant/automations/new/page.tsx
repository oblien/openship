import { redirect } from "next/navigation";
import { assistantDrawerHref } from "@/components/assistant/assistant-navigation";

export default async function NewAutomationPage({
  searchParams,
}: {
  searchParams: Promise<{ trigger?: string; agent?: string }>;
}) {
  const { trigger, agent } = await searchParams;
  const params = new URLSearchParams();
  if (trigger) params.set("trigger", trigger);
  if (agent) params.set("agent", agent);
  redirect(
    assistantDrawerHref(`/assistant/automations/new?${params}`, "/assistant", "tab=automations"),
  );
}
