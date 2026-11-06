import { redirect } from "next/navigation";
import { assistantDrawerHref } from "@/components/assistant/assistant-navigation";

export default async function EditAutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(
    assistantDrawerHref(
      `/assistant/automations/${encodeURIComponent(id)}/edit`,
      "/assistant",
      "tab=automations",
    ),
  );
}
