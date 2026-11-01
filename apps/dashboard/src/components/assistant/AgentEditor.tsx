"use client";
import { useCallback, useMemo, useReducer, useState } from "react";
import { Icon } from "@repo/ui/icons";
import {
  ASSISTANT_AGENT_RESOURCE_TYPES,
  ASSISTANT_AGENT_TEMPLATES,
  ASSISTANT_PROVIDER_LABELS,
  type AssistantAgent,
  type AssistantAgentConfig,
  type AssistantAgentIcon,
  type AssistantProvider,
} from "@repo/contracts";
import { Input, inputVariants } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import {
  useResourceScope,
  useScopedResource,
  useScopedMutation,
} from "@/hooks/use-scoped-resource";
import { assistantAgentsApi } from "@/lib/api/assistant-agents";
import { assistantApi } from "@/lib/api/assistant";
import { AccessControlEditor } from "@/components/permissions/AccessControlEditor";
import {
  reduceSelection,
  wireGrants,
  type AccessSelection,
  type ScopeAction,
  type TemplateContext,
} from "@/components/permissions/mcp-access-templates";
import type { CatalogEntry, ResourceType } from "@/lib/api";
import { AssistantDialog } from "./AssistantDialog";
import { AgentConnections } from "./AgentConnections";
import { AgentLink, useAgentNavigation } from "./AgentLink";
import { AgentIconPicker } from "./AgentAvatar";
import { resolveAgentAvatar } from "./agent-avatar";
import { AgentEditorSkeleton } from "./AssistantSkeletons";

export function AgentEditor({
  id,
  template,
  project,
}: {
  id?: string;
  template?: string;
  project?: string;
}) {
  const load = useCallback(() => (id ? assistantAgentsApi.get(id) : Promise.resolve(null)), [id]);
  const data = useScopedResource(load);
  if (data.error)
    return (
      <div role="alert" className="space-y-4 p-8 pt-16 text-sm text-danger">
        <p>{data.error}</p>
        <Button onClick={data.refresh}>Retry</Button>
      </div>
    );
  if (data.loading) return <AgentEditorSkeleton />;
  return (
    <Editor
      key={id ?? "new"}
      initial={data.data ?? undefined}
      templateId={template}
      project={project}
    />
  );
}
function Editor({
  initial,
  templateId,
  project,
}: {
  initial?: AssistantAgent;
  templateId?: string;
  project?: string;
}) {
  const scope = useResourceScope();
  const navigation = useAgentNavigation();
  const template = ASSISTANT_AGENT_TEMPLATES.find((t) => t.id === templateId);
  const backHref = initial ? `/assistant/agents/${initial.id}` : "/assistant/agents";
  const [requestId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(initial?.name ?? template?.name ?? "");
  const [icon, setIcon] = useState<AssistantAgentIcon>(() =>
    resolveAgentAvatar(initial?.icon ?? template?.icon, initial?.id ?? requestId),
  );
  const [purpose, setPurpose] = useState(initial?.purpose ?? template?.purpose ?? "");
  const [instructions, setInstructions] = useState(
    initial?.instructions ?? template?.instructions ?? "",
  );
  const [provider, setProvider] = useState<AssistantProvider>(initial?.provider ?? "codex");
  const [model, setModel] = useState(initial?.model ?? "");
  const [connections, setConnections] = useState(false);
  const ctx = useMemo<TemplateContext>(() => ({ githubAccounts: [] }), []);
  const [selection, dispatch] = useReducer(
    (s: AccessSelection, a: ScopeAction) => reduceSelection(s, a, ctx),
    {
      template: "custom",
      readOnly: initial?.readOnly ?? true,
      grants:
        initial?.grants ??
        (project ? [{ resourceType: "project", resourceId: project, permissions: ["read"] }] : []),
    } as AccessSelection,
  );
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(new Map());
  const catalog = useCallback(
    (type: ResourceType, entries: CatalogEntry[]) =>
      setLabels(
        (old) => new Map([...old, ...entries.map((e) => [`${type} ${e.id}`, e.label] as const)]),
      ),
    [],
  );
  const providers = useScopedResource(assistantApi.providers);
  const current = providers.data?.find((p) => p.id === provider);
  const mutation = useScopedMutation();
  const blocked =
    !name.trim() ||
    !purpose.trim() ||
    !selection.grants.length ||
    mutation.busy ||
    !!initial?.archived;
  const save = async () => {
    if (blocked) return;
    const input: AssistantAgentConfig = {
      name,
      icon,
      purpose,
      instructions,
      provider,
      model,
      readOnly: selection.readOnly,
      grants: wireGrants(selection),
    };
    const result = await mutation.execute(() =>
      assistantAgentsApi.save(
        input,
        initial ? { id: initial.id, revision: initial.revision } : { requestId },
      ),
    );
    if (result) {
      navigation?.changed();
      navigation?.navigate(`/assistant/agents/${result.id}`);
    }
  };
  return (
    <>
      <header className="mx-auto w-full max-w-[1480px] shrink-0 px-6 pb-6 pt-7 sm:px-10 lg:px-12">
        <AgentLink
          href={backHref}
          className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <Icon name="arrow-left" className="size-4" /> {initial ? initial.name : "All agents"}
        </AgentLink>
        <h2 className="pe-10 text-2xl font-medium">{initial ? "Edit agent" : "Create an agent"}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Give it a purpose and a clear scope. Use it for tasks, conversations and automations.
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-8 sm:px-10 lg:px-12">
        <div className="mx-auto grid max-w-[1384px] items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:gap-16">
          <div className="space-y-7">
            {!initial && (
              <div className="flex flex-wrap gap-2" aria-label="Agent templates">
                {ASSISTANT_AGENT_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      setName(t.name);
                      setIcon(t.icon);
                      setPurpose(t.purpose);
                      setInstructions(t.instructions);
                    }}
                    className="rounded-xl bg-card px-3 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-end gap-5">
              <AgentIconPicker value={icon} onChange={setIcon} />
              <div className="min-w-0 flex-1 space-y-2">
                <label htmlFor="agent-name" className="text-sm font-medium">
                  Name
                </label>
                <Input
                  id="agent-name"
                  variant="filled"
                  className="bg-card"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  placeholder="e.g. Production investigator"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="agent-purpose" className="text-sm font-medium">
                What is it responsible for?
              </label>
              <Input
                id="agent-purpose"
                variant="filled"
                className="bg-card"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                maxLength={500}
                placeholder="Trace failed deployments and explain the cause."
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="agent-instructions" className="text-sm font-medium">
                Working instructions
              </label>
              <textarea
                id="agent-instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                maxLength={8000}
                rows={5}
                className={`${inputVariants({ variant: "filled" })} h-auto min-h-36 resize-y bg-card py-4 leading-6 focus-visible:ring-0 focus-visible:ring-offset-0`}
                placeholder="Describe how it should investigate, what to verify, and how to report results."
              />
              <p className="text-xs leading-5 text-muted-foreground">
                Instructions guide its work. Assigned access decides what it can actually do.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="agent-connection" className="text-sm font-medium">
                  AI connection
                </label>
                <CustomSelect
                  id="agent-connection"
                  value={provider}
                  onChange={(v) => {
                    setProvider(v as AssistantProvider);
                    setModel("");
                  }}
                  options={(["codex", "claude"] as const).map((p) => ({
                    value: p,
                    label: ASSISTANT_PROVIDER_LABELS[p],
                    icon: <Icon name={p} className="size-4" />,
                  }))}
                  disabled={!!initial}
                  variant="filled"
                  triggerClassName="bg-muted/60 hover:bg-muted"
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="agent-model" className="text-sm font-medium">
                  Model
                </label>
                <CustomSelect
                  id="agent-model"
                  value={model}
                  onChange={setModel}
                  options={[
                    { value: "", label: "Connection default" },
                    ...(model && !current?.models.some((m) => m.id === model)
                      ? [{ value: model, label: model }]
                      : []),
                    ...(current?.models ?? []).map((m) => ({ value: m.id, label: m.label })),
                  ]}
                  variant="filled"
                  triggerClassName="bg-muted/60 hover:bg-muted"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => setConnections(true)}
              className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <Icon name="settings" className="size-4" />
              Manage connections or add your own API
            </button>
            {providers.error && (
              <p role="alert" className="text-sm text-danger">
                {providers.error}
              </p>
            )}
            <div className="flex items-start gap-3 text-sm leading-6 text-muted-foreground">
              <Icon name="workflow" className="mt-1 size-4 shrink-0" />
              <p>
                {initial
                  ? "Changing how this agent works stops current tasks and pauses its automations for review. Avatar changes keep them running."
                  : "Creating an agent does not start work. Give it a task or select it when creating an automation."}
              </p>
            </div>
          </div>
          <aside className="min-w-0">
            <div className="mb-5 flex items-start gap-3">
              <span className="rounded-xl bg-background p-2.5 text-muted-foreground">
                <Icon name="shield-check" className="size-5" />
              </span>
              <div>
                <h2 className="text-base font-medium">Assigned access</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Choose the resources this specialist can work with. Access stays within your
                  assistant’s approved permissions.
                </p>
              </div>
            </div>
            <AccessControlEditor
              selection={selection}
              dispatch={dispatch}
              availableTypes={[...ASSISTANT_AGENT_RESOURCE_TYPES]}
              ctx={ctx}
              orgKey={scope}
              orgName="this workspace"
              labels={labels}
              onCatalogLoaded={catalog}
              layout="stacked"
              show={{ templates: false, createCapability: false, capabilities: true }}
              suppressWildcardTypes={[...ASSISTANT_AGENT_RESOURCE_TYPES]}
              disabled={mutation.busy || initial?.archived}
            />
          </aside>
        </div>
      </div>
      <footer className="shrink-0 border-t border-border/50 px-6 py-5 sm:px-10 lg:px-12">
        {mutation.error && (
          <p role="alert" className="mb-4 text-sm text-danger">
            {mutation.error}
          </p>
        )}
        <div className="mx-auto flex max-w-[1384px] items-center justify-between gap-3">
          <Button
            variant="ghost"
            onClick={() => navigation?.navigate(backHref)}
            disabled={mutation.busy}
          >
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={blocked}>
            {mutation.busy ? "Saving…" : initial ? "Save changes" : "Create agent"}
            <Icon name="arrow-right" />
          </Button>
        </div>
      </footer>
      <AssistantDialog
        isOpen={connections}
        onClose={() => setConnections(false)}
        label="AI connections"
        width="720px"
        maxWidth="calc(100vw - 24px)"
        maxHeight="calc(100dvh - 24px)"
        overflow="auto"
      >
        <AgentConnections
          agents={providers.data ?? []}
          selected={provider}
          onSelect={setProvider}
          onRefresh={providers.refresh}
          loading={providers.loading}
          error={providers.error}
        />
      </AssistantDialog>
    </>
  );
}
