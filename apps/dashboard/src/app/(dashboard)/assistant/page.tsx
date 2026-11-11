"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AssistantWorkspace } from "@/components/assistant/AssistantWorkspace";
import { AssistantAutomations } from "@/components/assistant/AssistantAutomations";
export default function AssistantPage() {
  return (
    <Suspense
      fallback={
        <div role="status" className="p-8 text-sm text-muted-foreground">
          Loading assistant…
        </div>
      }
    >
      <AssistantView />
    </Suspense>
  );
}
function AssistantView() {
  const params = useSearchParams();
  return params.get("tab") === "automations" ? <AssistantAutomations /> : <AssistantWorkspace />;
}
