import { AutomationEditorPage } from "@/components/assistant/AutomationEditorPage";

export default async function EditAutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AutomationEditorPage id={id} />;
}
