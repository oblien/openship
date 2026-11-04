"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AgentLink } from "./AgentLink";
import { AgentAvatar } from "./AgentAvatar";
import { Icon, type IconName } from "@repo/ui/icons";
import {
  ASSISTANT_AUTOMATION_TRIGGERS,
  ASSISTANT_PROVIDER_LABELS,
  AUTOMATION_ACTIONS,
  automationActions,
  assistantModelReady,
  type AutomationAction,
  type AssistantAutomation,
  type AssistantAutomationConfig,
  type AssistantProviderInfo,
  type AssistantAgent,
} from "@repo/contracts";
import { Button } from "@/components/ui/button";
import { Input, inputVariants } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Switch } from "@/components/ui/Switch";
import { Checkbox } from "@/components/ui/Checkbox";
import type { NotificationChannel } from "@/lib/api/notifications";
import { useScopedResource, useScopedMutation } from "@/hooks/use-scoped-resource";
import { assistantAutomationsApi } from "@/lib/api/assistant-automations";
import { cn } from "@/lib/utils";
import { tokensApi, type McpClientDetail } from "@/lib/api/tokens";
import { McpAccessEditor } from "@/app/(dashboard)/settings/_components/McpAccessEditor";
import { AccessCopyProvider, ASSISTANT_ACCESS_COPY } from "@/components/permissions/access-copy";
import { AssistantDialog } from "./AssistantDialog";
import { ChannelLogo } from "@/components/ui/ChannelLogo";
import { AutomationSteps } from "./AutomationSteps";

const modes = [
  {
    id: "report",
    title: "Investigate & notify",
    text: "Explain the issue and suggest a next step.",
  },
  {
    id: "approve",
    title: "Ask before fixing",
    text: "Review the proposed fix before anything changes.",
  },
  {
    id: "automatic",
    title: "Fix automatically",
    text: "Apply a fix within the permissions you choose.",
  },
] as const;

const actionIcons: Record<AutomationAction, IconName> = {
  restart: "refresh",
  redeploy: "rocket",
  commit: "git-commit",
  pull_request: "git-branch",
};

export function AutomationEditor({
  initial,
  trigger,
  projects,
  agents,
  specialists,
  agentId,
  channels,
  onCancel,
  onSaved,
  onRefresh,
  clientId,
  embedded = false,
  initialStep = 0,
  paused = false,
}: {
  initial?: AssistantAutomation;
  trigger?: AssistantAutomationConfig["trigger"];
  projects: { id: string; name: string }[];
  agents: AssistantProviderInfo[];
  specialists: AssistantAgent[];
  agentId?: string;
  channels: NotificationChannel[];
  onRefresh(): void;
  clientId: string | null;
  onCancel(): void;
  onSaved(): void;
  embedded?: boolean;
  initialStep?: number;
  paused?: boolean;
}) {
  const [step, setStep] = useState<number | null>(initialStep);
  const openStep = useCallback(
    (next: number) => setStep((current) => (current === next ? null : next)),
    [],
  );
  const [form, setForm] = useState<AssistantAutomationConfig>(() =>
    initial
      ? {
          agentId: initial.agentId,
          name: initial.name,
          projectId: initial.projectId,
          trigger: initial.trigger,
          provider: initial.provider,
          model: initial.model,
          mode: initial.mode,
          action: initial.action,
          allowedActions: automationActions(initial),
          readRepository: initial.readRepository ?? false,
          instructions: initial.instructions,
          channelIds: initial.channelIds,
          cooldownMinutes: initial.cooldownMinutes,
          dailyLimit: initial.dailyLimit,
          enabled: initial.enabled,
          automaticConsent: false,
        }
      : {
          name:
            trigger === "service.unhealthy"
              ? "Investigate unhealthy services"
              : "Investigate failed deployments",
          agentId: agentId ?? null,
          projectId:
            specialists
              .find((a) => a.id === agentId)
              ?.grants.find((g) => g.resourceType === "project")?.resourceId ?? "",
          trigger: trigger ?? "deployment.failed",
          provider: specialists.find((a) => a.id === agentId)?.provider ?? "codex",
          model: specialists.find((a) => a.id === agentId)?.model ?? "",
          mode: "report",
          action: "none",
          allowedActions: [],
          readRepository: false,
          instructions: "",
          channelIds: [],
          cooldownMinutes: 30,
          dailyLimit: 5,
          enabled: false,
          automaticConsent: false,
        },
  );
  const mutation = useScopedMutation();
  const [detail, setDetail] = useState<McpClientDetail | null>(null);
  const [savingAccess, setSavingAccess] = useState(false);
  useEffect(() => {
    if (!embedded || detail || mutation.busy) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onCancel();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [embedded, detail, mutation.busy, onCancel]);
  const permissionFetcher = useCallback(
    () =>
      form.projectId
        ? assistantAutomationsApi.permissions(form.projectId, form.agentId ?? undefined)
        : Promise.resolve(null),
    [form.projectId, form.agentId],
  );
  const permissions = useScopedResource(permissionFetcher);
  const actions = automationActions(form);
  const readOnly = form.mode === "report";
  const reviewAccess = async () => {
    if (!clientId) return;
    const next = await mutation.execute(() => tokensApi.getMcpClient(clientId));
    if (next) setDetail(next.data);
  };
  useEffect(() => {
    const refresh = () => {
      onRefresh();
      permissions.refresh();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [onRefresh, permissions.refresh]);
  const set = <K extends keyof AssistantAutomationConfig>(
    key: K,
    value: AssistantAutomationConfig[K],
  ) => setForm((f) => ({ ...f, [key]: value }));
  const specialist = specialists.find((a) => a.id === form.agentId && !a.archived);
  const connection = agents.find((a) => a.id === specialist?.provider);
  const project = projects.find((p) => p.id === form.projectId);
  const connected = !!specialist && assistantModelReady(connection, specialist.model);
  const eligibleAgents = specialists.filter(
    (a) =>
      !a.archived &&
      a.grants.some((g) => g.resourceType === "project" && g.resourceId === form.projectId),
  );
  const permissionError =
    permissions.error ||
    permissions.data?.read.reason ||
    (form.readRepository ? permissions.data?.source.reason : null) ||
    actions.map((id) => permissions.data?.actions.find((a) => a.id === id)?.reason).find(Boolean);
  const stepReady = !!form.name.trim() && !!project;
  const canSave =
    form.cooldownMinutes >= 10 &&
    form.cooldownMinutes <= 1440 &&
    Number.isInteger(form.cooldownMinutes) &&
    form.dailyLimit >= 1 &&
    form.dailyLimit <= 20 &&
    Number.isInteger(form.dailyLimit) &&
    stepReady &&
    !!specialist &&
    !permissions.loading &&
    !permissionError &&
    (readOnly || actions.length > 0) &&
    (!form.enabled || connected) &&
    (form.mode !== "automatic" || form.automaticConsent);
  const save = async () => {
    if (!canSave) return;
    const result = await mutation.execute(() => assistantAutomationsApi.save(form, initial?.id));
    if (result) onSaved();
  };
  return (
    <div
      data-automation-editor={embedded ? "inline" : "page"}
      className={embedded ? "" : "mx-auto w-full max-w-3xl"}
    >
      <header className="sticky top-0 z-10 flex min-h-16 flex-wrap items-center justify-between gap-3 bg-background/90 py-3 backdrop-blur-xl">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {embedded ? (
            <span className="truncate text-sm">{project?.name ?? "Automation settings"}</span>
          ) : (
            <>
              <button
                type="button"
                onClick={onCancel}
                disabled={mutation.busy}
                className="inline-flex items-center gap-2 rounded-lg text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <Icon name="arrow-left" className="size-4 rtl:rotate-180" />
                Automations
              </button>
              <span aria-hidden className="hidden text-border sm:inline">
                /
              </span>
              <h1 className="sr-only text-sm font-medium text-foreground sm:not-sr-only">
                {initial ? "Edit automation" : "Create automation"}
              </h1>
            </>
          )}
          <span className="hidden shrink-0 items-center gap-2 text-xs text-muted-foreground sm:inline-flex">
            <Icon name={form.enabled && !paused ? "play" : "pause"} className="size-3" />
            {paused
              ? "All automations paused"
              : form.enabled
                ? "Enabled on save"
                : initial
                  ? "Paused"
                  : "Starts paused"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {embedded && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
              disabled={mutation.busy}
              aria-label="Cancel changes"
            >
              Cancel
            </Button>
          )}
          <Button size="sm" onClick={save} disabled={!canSave || mutation.busy}>
            {mutation.busy
              ? "Saving…"
              : initial
                ? "Save changes"
                : form.enabled
                  ? "Enable automation"
                  : "Save paused"}
          </Button>
        </div>
      </header>
      <div className="mb-6">
        <AutomationSteps
          flow={{ ...form, agentName: specialist?.name ?? "Choose an agent" }}
          currentStep={step}
          onSelect={openStep}
          disabled={mutation.busy}
        >
          <div className="space-y-5">
            {step === 0 && (
              <>
                <div className="grid gap-4 @lg:grid-cols-2">
                  <Field label="Automation name" id="automation-name">
                    <Input
                      variant="filled"
                      className="bg-background focus:bg-background"
                      id="automation-name"
                      value={form.name}
                      onChange={(e) => set("name", e.target.value)}
                      maxLength={80}
                    />
                  </Field>
                  <Field label="App" id="automation-project">
                    <CustomSelect
                      variant="filled"
                      triggerClassName="bg-muted/60 hover:bg-muted"
                      id="automation-project"
                      value={form.projectId}
                      onChange={(v) =>
                        setForm((f) => ({
                          ...f,
                          projectId: v,
                          allowedActions: [],
                          action: "none",
                          mode: "report",
                          readRepository: false,
                          automaticConsent: false,
                        }))
                      }
                      placeholder="Choose an app"
                      emptyMessage="No apps in this workspace yet"
                      footerAction={{
                        label: "Create an app",
                        icon: <Icon name="plus" className="size-4" />,
                        onClick: () => window.open("/library", "_blank", "noopener,noreferrer"),
                      }}
                      options={projects.map((p) => ({ value: p.id, label: p.name }))}
                    />
                  </Field>
                </div>
                {!projects.length && (
                  <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-card p-5">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-info-bg text-info">
                      <Icon name="plus" className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">Start with your first app</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Create an app in a new tab. This flow stays here while you set it up.
                      </p>
                    </div>
                    <Button asChild variant="secondary">
                      <Link href="/library" target="_blank" rel="noopener noreferrer">
                        Create an app <Icon name="arrow-up-right" />
                      </Link>
                    </Button>
                  </div>
                )}
                <Field label="Trigger event" id="automation-trigger">
                  <CustomSelect
                    id="automation-trigger"
                    variant="filled"
                    triggerClassName="bg-muted/60 hover:bg-muted"
                    value={form.trigger}
                    options={ASSISTANT_AUTOMATION_TRIGGERS.map((trigger) => ({
                      value: trigger.id,
                      label: trigger.label,
                      description: trigger.description,
                    }))}
                    onChange={(trigger) =>
                      setForm((f) => ({
                        ...f,
                        trigger,
                        allowedActions: automationActions(f).filter(
                          (action) => trigger !== "deployment.failed" || action !== "restart",
                        ),
                        automaticConsent: false,
                      }))
                    }
                  />
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    Planned stops and ongoing deployments are excluded.
                  </p>
                </Field>
              </>
            )}
            {step === 1 && (
              <>
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor="automation-agent" className="text-sm">
                      Agent
                    </label>
                    <AgentLink
                      href={`/assistant/agents/new?project=${encodeURIComponent(form.projectId)}`}
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <Icon name="plus" className="size-3.5" /> Create an agent
                    </AgentLink>
                  </div>
                  <CustomSelect
                    id="automation-agent"
                    variant="filled"
                    triggerClassName="bg-muted/60 hover:bg-muted"
                    value={form.agentId ?? ""}
                    placeholder="Choose an agent"
                    emptyMessage="No agents have access to this app"
                    options={eligibleAgents.map((agent) => ({
                      value: agent.id,
                      label: agent.name,
                      description: agent.purpose,
                      icon: <AgentAvatar icon={agent.icon} agentId={agent.id} className="size-5" />,
                    }))}
                    onChange={(id) => {
                      const agent = eligibleAgents.find((a) => a.id === id);
                      if (!agent) return;
                      setForm((f) => ({
                        ...f,
                        agentId: agent.id,
                        provider: agent.provider,
                        model: agent.model,
                        automaticConsent: false,
                      }));
                    }}
                  />
                  {!eligibleAgents.length && (
                    <p className="text-xs leading-5 text-muted-foreground">
                      Create an agent with access to {project?.name ?? "this app"}. Its instructions
                      and permissions will follow every task.
                    </p>
                  )}
                  {specialist && (
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>
                        {specialist.readOnly ? "Read-only" : "Scoped actions"} ·{" "}
                        {specialist.model || ASSISTANT_PROVIDER_LABELS[specialist.provider]}
                      </span>
                      <AgentLink
                        href={`/assistant/agents/${specialist.id}/edit`}
                        className="inline-flex items-center gap-1 hover:text-foreground"
                      >
                        Edit agent & access
                        <Icon name="arrow-up-right" className="size-3.5" />
                      </AgentLink>
                    </div>
                  )}
                  {specialist && !connected && (
                    <p className="text-xs text-warning">
                      Connect this agent’s AI account before enabling the flow.
                    </p>
                  )}
                </div>
                {permissions.data?.repository && (
                  <label className="flex cursor-pointer items-center gap-3 rounded-xl bg-card p-4">
                    <Icon name="github" className="size-5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">Read app source code</span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                        {permissions.data.repository} ·{" "}
                        {permissions.data.source.allowed
                          ? "Within approved source paths."
                          : permissions.data.source.reason}
                      </span>
                    </span>
                    <Checkbox
                      checked={!!form.readRepository}
                      disabled={
                        actions.some((a) => a === "commit" || a === "pull_request") ||
                        !permissions.data.source.allowed
                      }
                      onCheckedChange={(v) => set("readRepository", v)}
                      aria-label="Read app source code"
                    />
                  </label>
                )}
                <Field label="Investigation guidance (optional)" id="automation-instructions">
                  <textarea
                    id="automation-instructions"
                    value={form.instructions}
                    maxLength={2000}
                    onChange={(e) => set("instructions", e.target.value)}
                    className={cn(
                      inputVariants({ variant: "filled" }),
                      "min-h-28 resize-y bg-background text-sm focus:bg-background",
                    )}
                    placeholder="e.g. Check recent deployment logs and database connectivity. Explain the cause before recommending a restart."
                  />
                </Field>
                <div className="flex gap-3 text-xs leading-5 text-muted-foreground">
                  <Icon name="shield-check" className="mt-0.5 size-4 shrink-0" />
                  <p>
                    The investigation can read only the selected app. Your agent receives temporary,
                    read-only access; logs may be sent to your connected AI provider.
                  </p>
                </div>
              </>
            )}
            {step === 2 && (
              <>
                <Field label="Response mode" id="automation-response">
                  <CustomSelect
                    id="automation-response"
                    variant="filled"
                    triggerClassName="bg-muted/60 hover:bg-muted"
                    value={form.mode}
                    options={modes.map((mode) => ({
                      value: mode.id,
                      label: mode.title,
                      description: mode.text,
                    }))}
                    onChange={(mode) =>
                      setForm((f) => ({
                        ...f,
                        mode,
                        action: "none",
                        allowedActions: mode === "report" ? [] : automationActions(f),
                        automaticConsent: false,
                      }))
                    }
                  />
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {modes.find((mode) => mode.id === form.mode)?.text}
                  </p>
                </Field>
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-4">
                    <div>
                      <h3 className="text-sm font-medium">Permissions for this flow</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {readOnly
                          ? "Investigation stays read-only."
                          : `Choose what it can do to ${project?.name ?? "this app"}.`}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void reviewAccess()}
                      disabled={!clientId || mutation.busy}
                    >
                      <Icon name="shield-check" />
                      Review assistant access
                    </Button>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <Icon
                      name={permissions.data?.read.allowed ? "check" : "lock"}
                      className={cn(
                        "size-4 shrink-0",
                        permissions.data?.read.allowed ? "text-info" : "text-muted-foreground",
                      )}
                    />
                    <span>
                      {permissions.data?.read.allowed
                        ? "Read this app’s status, deployment logs and health."
                        : "Approve access to this app’s status, deployment logs and health."}
                    </span>
                  </div>
                  {!readOnly &&
                    ["App recovery", "Repository"].map((group) => (
                      <fieldset key={group}>
                        <legend className="mb-1 flex w-full items-center gap-2 text-xs font-medium text-muted-foreground">
                          <span>{group}</span>
                          {group === "Repository" && permissions.data?.repository && (
                            <span className="truncate font-normal">
                              · {permissions.data.repository}
                            </span>
                          )}
                        </legend>
                        <div className="divide-y divide-border/40">
                          {AUTOMATION_ACTIONS.filter((a) => a.group === group).map((a) => {
                            const access = permissions.data?.actions.find((p) => p.id === a.id);
                            const unavailable =
                              !access?.allowed ||
                              (form.trigger === "deployment.failed" && a.id === "restart");
                            return (
                              <label
                                key={a.id}
                                className={cn(
                                  "flex items-center gap-4 py-3",
                                  unavailable ? "cursor-not-allowed" : "cursor-pointer",
                                )}
                              >
                                <span
                                  className={cn(
                                    "flex size-9 shrink-0 items-center justify-center rounded-xl",
                                    unavailable
                                      ? "bg-card text-muted-foreground"
                                      : "bg-info-bg text-info",
                                  )}
                                >
                                  <Icon name={actionIcons[a.id]} className="size-4" />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block text-sm font-medium">{a.label}</span>
                                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                                    {a.description}
                                  </span>
                                  {unavailable && (
                                    <span className="mt-1 block text-xs leading-5 text-warning">
                                      {form.trigger === "deployment.failed" && a.id === "restart"
                                        ? "Available for service health incidents."
                                        : (access?.reason ?? "Choose an app to check access.")}
                                    </span>
                                  )}
                                </span>
                                <Checkbox
                                  size="lg"
                                  checked={actions.includes(a.id)}
                                  disabled={unavailable}
                                  onCheckedChange={(checked) =>
                                    setForm((f) => ({
                                      ...f,
                                      action: "none",
                                      allowedActions: checked
                                        ? [...automationActions(f), a.id]
                                        : automationActions(f).filter((id) => id !== a.id),
                                      readRepository:
                                        f.readRepository ||
                                        (checked && (a.id === "commit" || a.id === "pull_request")),
                                      automaticConsent: false,
                                    }))
                                  }
                                  aria-label={a.label}
                                />
                              </label>
                            );
                          })}
                        </div>
                      </fieldset>
                    ))}
                  {permissionError && (
                    <p role="alert" className="text-sm text-danger">
                      {permissionError}
                    </p>
                  )}
                  {!readOnly && (
                    <p className="text-xs leading-5 text-muted-foreground">
                      The agent recommends one fix from these permissions. Repository changes stay
                      on a new branch and may trigger your CI. App recovery runs through the normal
                      deployment pipeline and health checks.
                    </p>
                  )}
                  {form.mode === "automatic" && (
                    <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-warning-bg p-5">
                      <Checkbox
                        checked={form.automaticConsent}
                        onCheckedChange={(v) => set("automaticConsent", v)}
                        aria-label="Approve automatic actions"
                      />
                      <span className="text-sm leading-6">
                        Allow the selected actions on{" "}
                        <strong className="font-medium">{project?.name ?? "this app"}</strong>{" "}
                        without asking each time. Deployments can interrupt services; repository
                        changes can run CI.
                      </span>
                    </label>
                  )}
                </div>
              </>
            )}
            {step === 3 && (
              <>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Icon name="message" className="size-4 shrink-0 text-muted-foreground" />
                  Results are always saved in agent chat.
                </div>
                <fieldset>
                  <legend className="mb-3 flex w-full items-center justify-between gap-3 text-sm font-medium">
                    Also notify
                    <Link
                      href="/settings?tab=notifications"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground"
                    >
                      Manage channels <Icon name="arrow-up-right" className="size-3.5" />
                    </Link>
                  </legend>
                  <div className="divide-y divide-border/40">
                    {channels
                      .filter((c) => c.enabled && c.verified)
                      .map((c) => (
                        <label key={c.id} className="flex cursor-pointer items-center gap-3 py-3">
                          <span className="flex size-8 items-center justify-center rounded-lg bg-muted/50">
                            <ChannelLogo kind={c.kind} className="size-5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm">{c.label}</span>
                            <span className="mt-1 block text-xs capitalize text-muted-foreground">
                              {c.kind}
                            </span>
                          </span>
                          <Checkbox
                            checked={form.channelIds.includes(c.id)}
                            onCheckedChange={(v) =>
                              set(
                                "channelIds",
                                v
                                  ? [...form.channelIds, c.id]
                                  : form.channelIds.filter((id) => id !== c.id),
                              )
                            }
                            aria-label={c.label}
                          />
                        </label>
                      ))}
                  </div>
                  {!channels.some((c) => c.enabled && c.verified) && (
                    <p className="py-3 text-sm text-muted-foreground">
                      Connect a notification channel to get updates outside OpenShip.
                    </p>
                  )}
                  <p className="mt-3 text-xs leading-5 text-muted-foreground">
                    Sends a status update and private link. Logs stay in the conversation.
                  </p>
                </fieldset>
                <details className="group border-t border-border/40 pt-5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm [&::-webkit-details-marker]:hidden">
                    <span className="flex items-center gap-2.5">
                      <Icon name="history" className="size-4 text-muted-foreground" /> Run limits
                    </span>
                    <span className="flex items-center gap-3 text-xs text-muted-foreground">
                      {form.dailyLimit} / day · {form.cooldownMinutes} min apart{" "}
                      <Icon
                        name="chevron-down"
                        className="size-4 transition-transform group-open:rotate-180"
                      />
                    </span>
                  </summary>
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <Field label="Cooldown (minutes)" id="automation-cooldown">
                      <Input
                        variant="filled"
                        className="bg-background focus:bg-background"
                        id="automation-cooldown"
                        type="number"
                        min={10}
                        max={1440}
                        value={form.cooldownMinutes}
                        onChange={(e) => set("cooldownMinutes", Number(e.target.value))}
                      />
                    </Field>
                    <Field label="Maximum runs per day" id="automation-limit">
                      <Input
                        variant="filled"
                        className="bg-background focus:bg-background"
                        id="automation-limit"
                        type="number"
                        min={1}
                        max={20}
                        value={form.dailyLimit}
                        onChange={(e) => set("dailyLimit", Number(e.target.value))}
                      />
                    </Field>
                  </div>
                </details>
                <div className="flex items-center justify-between gap-4 border-t border-border/40 pt-5">
                  <div>
                    <p className="text-sm font-medium">Enable this automation</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {paused
                        ? "All automations are paused. Resume them before this flow can run."
                        : "Starts with new incidents after you save."}
                    </p>
                  </div>
                  <Switch
                    checked={form.enabled}
                    onChange={(v) => set("enabled", v)}
                    disabled={!connected}
                    ariaLabel="Enable this automation"
                  />
                </div>
              </>
            )}
          </div>
        </AutomationSteps>
        {mutation.error && (
          <p role="alert" className="mt-4 text-sm text-danger">
            {mutation.error}
          </p>
        )}
      </div>
      <AssistantDialog
        isOpen={!!detail}
        label="Assistant permissions"
        onClose={() => setDetail(null)}
        closable={!savingAccess}
        width="1120px"
        maxWidth="96vw"
        height="min(850px, calc(100dvh - 32px))"
        overflow="hidden"
      >
        {detail && (
          <AccessCopyProvider value={ASSISTANT_ACCESS_COPY}>
            <McpAccessEditor
              detail={detail}
              layout="dialog"
              onBusyChange={setSavingAccess}
              onClose={() => setDetail(null)}
              onSaved={() => {
                setDetail(null);
                permissions.refresh();
              }}
            />
          </AccessCopyProvider>
        )}
      </AssistantDialog>
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
