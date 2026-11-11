import { redirect } from "next/navigation";
import { assistantDrawerHref } from "@/components/assistant/assistant-navigation";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(assistantDrawerHref(`/assistant/agents/${encodeURIComponent(id)}/edit`));
}
