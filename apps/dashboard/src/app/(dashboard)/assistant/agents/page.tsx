import { redirect } from "next/navigation";
import { assistantDrawerHref } from "@/components/assistant/assistant-navigation";

export default function Page() {
  redirect(assistantDrawerHref("/assistant/agents"));
}
