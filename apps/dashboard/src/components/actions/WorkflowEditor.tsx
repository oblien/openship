"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { PageContainer } from "@/components/ui/PageContainer";
import { WorkflowSetup } from "./WorkflowSetup";

/** The full page and embedded project/deployment flows use the same setup. */
export function WorkflowEditor({ id }: { id?: string }) {
  const router = useRouter(),
    params = useSearchParams();
  const projectId = params.get("projectId") || undefined;
  return (
    <PageContainer>
      <WorkflowSetup
        id={id}
        initial={{
          projectId,
          owner: params.get("owner") || undefined,
          repo: params.get("repo") || undefined,
          ref: params.get("ref") || undefined,
        }}
        onCancel={() =>
          router.push(projectId ? `/projects/${encodeURIComponent(projectId)}/actions` : "/actions")
        }
        onSaved={(workflow, saved = [workflow]) =>
          router.push(
            projectId
              ? `/projects/${encodeURIComponent(projectId)}/actions`
              : saved.length > 1
                ? "/actions"
                : `/actions/workflows/${workflow.id}`,
          )
        }
      />
    </PageContainer>
  );
}
