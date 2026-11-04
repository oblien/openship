import { Suspense, type ReactNode } from "react";
import { AgentDrawerLayout } from "@/components/assistant/AgentDrawer";

export default function AssistantLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={children}>
      <AgentDrawerLayout>{children}</AgentDrawerLayout>
    </Suspense>
  );
}
