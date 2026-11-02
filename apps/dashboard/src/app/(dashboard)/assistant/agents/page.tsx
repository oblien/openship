import { redirect } from "next/navigation";
import { agentDrawerHref } from "@/components/assistant/agent-navigation";

export default function Page() {
  redirect(agentDrawerHref("/assistant/agents"));
}
