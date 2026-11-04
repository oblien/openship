"use client";

import { Suspense, useCallback, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import type { AssistantAutomationConfig, AssistantAutomationOverview } from "@repo/contracts";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { useResourceScope, useScopedResource } from "@/hooks/use-scoped-resource";
import { useToast } from "@/context/ToastContext";
import { assistantAgentsApi } from "@/lib/api/assistant-agents";
import { assistantApi } from "@/lib/api/assistant";
import { assistantAutomationsApi } from "@/lib/api/assistant-automations";
import { notificationsApi } from "@/lib/api/notifications";
import { projectsApi } from "@/lib/api/projects";
import { AutomationEditor } from "./AutomationEditor";
import { AutomationEditorSkeleton, type AutomationPreview } from "./AutomationSkeleton";
import { useAgentNavigation } from "./AgentLink";

const automationsHref = "/assistant?tab=automations";
const noOverview = async () => null;

export function AutomationEditorPage({ id }: { id?: string }) {
  return (
    <PageContainer fullScreen={false} className="flex min-h-full w-full max-w-none flex-col py-0">
      <Suspense fallback={<AutomationEditorSkeleton />}>
        <ScopedEditor id={id} />
      </Suspense>
    </PageContainer>
  );
}

function ScopedEditor({ id }: { id?: string }) {
  const scope = useResourceScope();
  const params = useSearchParams();
  const trigger =
    params.get("trigger") === "service.unhealthy" ? "service.unhealthy" : "deployment.failed";
  return (
    <EditorAccess
      key={`${scope}:${id ?? trigger}`}
      id={id}
      trigger={trigger}
      agentId={params.get("agent") ?? undefined}
    />
  );
}

function EditorAccess(props: {
  id?: string;
  agentId?: string;
  trigger: AssistantAutomationConfig["trigger"];
}) {
  const status = useScopedResource(assistantApi.status);
  if (status.loading) return <AutomationEditorSkeleton />;
  if (status.error) {
    return (
      <EditorState
        title="Couldn’t load your assistant"
        error={status.error}
        onRetry={status.refresh}
      />
    );
  }
  if (!status.data?.enabled) {
    return (
      <EditorState
        title="Set up your assistant first"
        description="Connect your agent and choose its access before creating an automation."
      >
        <Button asChild>
          <Link href="/assistant">
            Set up your assistant <Icon name="arrow-right" />
          </Link>
        </Button>
      </EditorState>
    );
  }
  return <AutomationEditorData {...props} clientId={status.data.clientId} />;
}

export function AutomationEditorData({
  id,
  trigger,
  agentId,
  clientId,
  embedded,
  initialStep,
  onCancel,
  onSaved,
  preview,
}: {
  id?: string;
  trigger?: AssistantAutomationConfig["trigger"];
  agentId?: string;
  clientId: string | null;
  embedded?: boolean;
  initialStep?: number;
  onCancel?(): void;
  onSaved?(): void;
  preview?: AutomationPreview;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const overview = useScopedResource<AssistantAutomationOverview | null>(
    id ? assistantAutomationsApi.overview : noOverview,
  );
  const projects = useScopedResource(projectsApi.getHome);
  const agents = useScopedResource(assistantApi.providers);
  const specialists = useScopedResource(assistantAgentsApi.list);
  const agentRevision = useAgentNavigation()?.revision ?? 0;
  useEffect(() => {
    if (agentRevision) specialists.refresh();
  }, [agentRevision, specialists.refresh]);
  const channels = useScopedResource(notificationsApi.listChannels);
  const refresh = useCallback(() => {
    projects.refresh();
    agents.refresh();
    specialists.refresh();
    channels.refresh();
  }, [projects.refresh, agents.refresh, channels.refresh, specialists.refresh]);
  const error =
    overview.error ?? projects.error ?? agents.error ?? specialists.error ?? channels.error;
  if (error) {
    return (
      <EditorState
        title="Couldn’t load the flow editor"
        onCancel={onCancel}
        error={error}
        onRetry={() => {
          overview.refresh();
          projects.refresh();
          agents.refresh();
          specialists.refresh();
          channels.refresh();
        }}
      />
    );
  }
  if (
    overview.loading ||
    projects.loading ||
    agents.loading ||
    specialists.loading ||
    channels.loading
  ) {
    return (
      <AutomationEditorSkeleton
        preview={preview}
        embedded={embedded}
        initialStep={initialStep}
        onCancel={onCancel}
      />
    );
  }
  const initial = id ? overview.data?.automations.find((flow) => flow.id === id) : undefined;
  if (id && !initial) {
    return (
      <EditorState
        title="Automation not available"
        onCancel={onCancel}
        description="This flow is no longer available in your current account and workspace."
      />
    );
  }
  return (
    <AutomationEditor
      embedded={embedded}
      initialStep={initialStep}
      initial={initial}
      paused={overview.data?.paused ?? false}
      trigger={trigger}
      projects={projects.data?.projects ?? []}
      agents={agents.data ?? []}
      specialists={specialists.data ?? []}
      agentId={agentId}
      channels={channels.data?.channels ?? []}
      clientId={clientId}
      onRefresh={refresh}
      onCancel={onCancel ?? (() => router.push(automationsHref))}
      onSaved={() => {
        if (onSaved) return onSaved();
        showToast(initial ? "Automation updated" : "Automation created", "success");
        router.push(automationsHref);
      }}
    />
  );
}

function EditorState({
  title,
  description,
  error,
  onRetry,
  onCancel,
  children,
}: {
  title: string;
  description?: string;
  error?: string;
  onRetry?(): void;
  onCancel?(): void;
  children?: React.ReactNode;
}) {
  return (
    <>
      {onCancel ? (
        <button
          type="button"
          onClick={onCancel}
          className="my-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <Icon name="arrow-left" className="size-4" />
          Cancel editing
        </button>
      ) : (
        <Link
          href={automationsHref}
          className="my-6 inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <Icon name="arrow-left" className="size-4 rtl:rotate-180" /> Automations
        </Link>
      )}
      <div className="mx-auto my-auto max-w-lg py-12 text-center" role={error ? "alert" : "status"}>
        <Icon name="workflow" className="mx-auto mb-5 size-7 text-muted-foreground" />
        <h1 className="text-xl font-medium">{title}</h1>
        {(description || error) && (
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{error ?? description}</p>
        )}
        {onRetry && (
          <Button className="mt-6" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        )}
        {children && <div className="mt-6">{children}</div>}
      </div>
    </>
  );
}
