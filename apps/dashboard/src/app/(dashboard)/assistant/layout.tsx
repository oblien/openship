import { Suspense, type ReactNode } from "react";
import { AssistantDrawerLayout } from "@/components/assistant/AssistantDrawer";

export default function AssistantLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={children}>
      <AssistantDrawerLayout>{children}</AssistantDrawerLayout>
    </Suspense>
  );
}
