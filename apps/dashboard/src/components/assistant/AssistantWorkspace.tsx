"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ASSISTANT_PROVIDER_LABELS,
  isAssistantActive,
  assistantModelReady,
  assistantDefaultModel,
  type AssistantAuthorization,
  type AssistantMessage,
  type AssistantProvider,
  type AssistantTarget,
  type PermissionAccessRequest,
} from "@repo/contracts";
import { Icon, type IconName } from "@repo/ui/icons";
import {
  useResourceScope,
  useResourceScopeReady,
  useScopedMutation,
  useScopedResource,
} from "@/hooks/use-scoped-resource";
import { assistantApi } from "@/lib/api/assistant";
import { assistantAgentsApi } from "@/lib/api/assistant-agents";
import { assistantAutomationsApi } from "@/lib/api/assistant-automations";
import { tokensApi, type McpClientDetail } from "@/lib/api/tokens";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/PageContainer";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Drawer } from "@/components/ui/Drawer";
import { AssistantDialog } from "./AssistantDialog";
import DropdownMenu from "@/components/ui/DropdownMenu";
import { McpAccessEditor } from "@/app/(dashboard)/settings/_components/McpAccessEditor";
import { McpAuthorizationForm } from "@/components/permissions/McpAuthorizationForm";
import { PermissionReviewSkeleton } from "@/components/permissions/PermissionReviewSkeleton";
import { AccessCopyProvider, ASSISTANT_ACCESS_COPY } from "@/components/permissions/access-copy";
import { AssistantTranscript } from "./AssistantTranscript";
import { AssistantConversationLayout } from "./AssistantConversationLayout";
import { AccessRequestSummary } from "./AssistantAccessRequest";
import { AssistantQuestions } from "./AssistantQuestions";
import { AssistantComposer } from "./AssistantComposer";
import { useAssistantImages } from "./use-assistant-images";
import { AssistantIntroduction } from "./AssistantIntroduction";
import { AssistantRail } from "./AssistantRail";
import { ConversationHistory } from "./ConversationHistory";
import { AssistantAutomationDetail } from "./AssistantAutomationDetail";
import { AssistantWorkspaceSkeleton, ConversationSkeleton } from "./AssistantSkeletons";
import { agentChatKey, agentResumeChat } from "./rail-navigation";
import { AgentConnections } from "./AgentConnections";
import { AgentLink, useAgentNavigation } from "./AgentLink";
import { AgentAvatar } from "./AgentAvatar";
import { AssistantChatIdentity } from "./AssistantChatIdentity";
import { useConversation } from "./use-conversation";
import { useAssistantResume } from "./use-assistant-resume";
import { AutomationConversationStatus } from "./AutomationRunReview";
import { useI18n } from "@/components/i18n-provider";
import {
  investigationPrompt,
  readInvestigation,
  type AssistantInvestigation,
} from "./investigation";

const suggestions: Array<{ icon: IconName; title: string; prompt: string }> = [
  {
    icon: "activity",
    title: "Check my apps",
    prompt:
      "Check the health and recent deployments of the apps I have given you access to. Summarize any issues before making changes.",
  },
  {
    icon: "rocket",
    title: "Help me deploy",
    prompt:
      "Help me deploy an application. First ask which repository and destination I want to use, and explain the plan before deploying.",
  },
  {
    icon: "terminal",
    title: "Investigate an issue",
    prompt:
      "Help me investigate an application issue. Ask which app and what happened, then inspect its status and relevant logs.",
  },
];
export function AssistantWorkspace() {
  const scope = useResourceScope();
  return (
    <PageContainer fullScreen={false} className="flex h-full min-h-0 flex-col py-5">
      <AssistantEntry key={scope} scope={scope} />
    </PageContainer>
  );
}

function AssistantEntry({ scope }: { scope: string }) {
  const scopeReady = useResourceScopeReady();
  const { t } = useI18n();
  const investigation = readInvestigation(useSearchParams(), scope);
  const status = useScopedResource(assistantApi.status);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [authorization, setAuthorization] = useState<AssistantAuthorization | null>(null);
  const [consenting, setConsenting] = useState(false);
  const [targetId, setTargetId] = useState("");
  const targets = status.data?.targets ?? [];
  const chosenTarget = targets.find((t) => t.id === targetId) ?? targets[0];
  const action = useScopedMutation();
  const openPermissions = async () => {
    setAuthorization(null);
    setConsenting(false);
    setPermissionsOpen(true);
    const prepared = await action.execute(() => assistantApi.enable(chosenTarget?.id));
    if (prepared) setAuthorization(prepared);
  };
  const complete = async (redirectURI: string | null, accepted: boolean) => {
    if (accepted) {
      const callback = redirectURI ? new URL(redirectURI) : null;
      const code = callback?.searchParams.get("code");
      if (!authorization || !code || callback?.searchParams.get("state") !== authorization.state)
        throw new Error("The permission response did not match this request.");
      const result = await assistantApi.completeAuthorization(authorization.state, code);
      if (!result.enabled) throw new Error("Assistant authorization was not completed.");
      status.refresh();
    }
    setPermissionsOpen(false);
    setAuthorization(null);
    setConsenting(false);
  };
  useEffect(() => {
    const refresh = () => status.refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [status.refresh]);
  if ((status.loading && !status.data) || (investigation.status !== "none" && !scopeReady))
    return <AssistantWorkspaceSkeleton />;
  if (investigation.status === "invalid")
    return (
      <div className="m-auto flex max-w-lg flex-col items-center gap-5 px-4 text-center">
        <Icon name="assistant" className="size-8 text-muted-foreground" />
        <p role="alert" className="text-base leading-7 text-muted-foreground">
          {t.dashboard.investigation.invalid}
        </p>
        <Button asChild variant="secondary">
          <Link href="/assistant">{t.dashboard.investigation.back}</Link>
        </Button>
      </div>
    );
  if (status.data?.enabled)
    return (
      <ConversationWorkspace
        key={`${status.data.clientId}:${status.data.target?.id ?? ""}`}
        clientId={status.data.clientId!}
        target={status.data.target}
        onDisabled={status.refresh}
        investigation={investigation.status === "ready" ? investigation : null}
      />
    );
  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4">
        <h1 className="text-2xl font-medium text-foreground">AI Agents</h1>
      </header>
      <AssistantIntroduction>
        {investigation.status === "ready" && (
          <p
            role="status"
            className="mb-5 rounded-xl bg-card p-4 text-sm leading-6 text-muted-foreground"
          >
            {t.dashboard.investigation.setup}
          </p>
        )}
        {!status.loading && targets.some((t) => t.kind === "server") && (
          <div className="mb-5 text-start">
            <label className="mb-2 block text-sm font-medium" htmlFor="assistant-host">
              Agent host
            </label>
            <CustomSelect
              id="assistant-host"
              options={targets.map((t) => ({
                value: t.id,
                label: t.name,
                icon: <Icon name="server" className="size-4" />,
              }))}
              value={chosenTarget?.id ?? ""}
              onChange={setTargetId}
              placeholder="Choose your server"
              variant="filled"
              triggerClassName="bg-muted/60 hover:bg-muted h-11"
              disabled={action.busy}
            />
          </div>
        )}
        {!status.loading && !targets.length && !status.error ? (
          <div className="text-sm leading-6 text-muted-foreground">
            <p>Connect a server to give your agents a place to work.</p>
            <Button asChild size="lg" className="mt-4 w-full gap-3 px-5">
              <Link href="/servers/new">
                Connect a server <Icon name="arrow-right" />
              </Link>
            </Button>
          </div>
        ) : (
          <>
            <Button
              size="lg"
              className="h-11 w-full gap-3 rounded-xl px-5"
              disabled={
                status.loading ||
                action.busy ||
                !!status.error ||
                status.data?.available === false ||
                !chosenTarget
              }
              onClick={() => void openPermissions()}
            >
              {status.loading ? "Loading…" : action.busy ? "Opening setup…" : "Enable AI Agents"}
              <Icon
                name={status.loading || action.busy ? "spinner" : "arrow-right"}
                className={status.loading || action.busy ? "animate-spin" : ""}
              />
            </Button>
            <p className="mt-3 text-center text-xs leading-5 text-muted-foreground">
              You choose what your agents can access.
            </p>
          </>
        )}
        {(status.error || action.error) && (
          <p role="alert" className="mt-4 text-sm text-danger">
            {status.error || action.error}
            <button className="ms-2 underline" onClick={status.refresh}>
              Retry
            </button>
          </p>
        )}
      </AssistantIntroduction>
      <AssistantDialog
        label="Enable assistant"
        isOpen={permissionsOpen}
        onClose={() => setPermissionsOpen(false)}
        closable={!action.busy && !consenting}
        width="1180px"
        maxWidth="calc(100vw - 32px)"
        height="min(850px, calc(100dvh - 32px))"
        maxHeight="calc(100dvh - 32px)"
        overflow="hidden"
      >
        {authorization ? (
          <McpAuthorizationForm
            presentation="assistant"
            clientId={authorization.clientId}
            consentCode={authorization.consentCode}
            organizationId={authorization.organizationId}
            onComplete={complete}
            onBusyChange={setConsenting}
          />
        ) : action.busy ? (
          <PermissionReviewSkeleton />
        ) : (
          <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
            <p role="alert" className="text-sm text-danger">
              {action.error}
            </p>
            <Button variant="secondary" onClick={() => void openPermissions()}>
              Try again
            </Button>
          </div>
        )}
      </AssistantDialog>
    </>
  );
}
function ConversationWorkspace({
  clientId,
  target,
  onDisabled,
  investigation,
}: {
  clientId: string;
  target: AssistantTarget | null;
  onDisabled(): void;
  investigation: { target: AssistantInvestigation; key: string } | null;
}) {
  const { t } = useI18n();
  const investigationCopy = t.dashboard.investigation;
  const router = useRouter(),
    search = useSearchParams();
  const scope = useResourceScope();
  const scopeReady = useResourceScopeReady();
  const chats = useScopedResource(assistantApi.list, 5000);
  const savedAgents = useScopedResource(assistantAgentsApi.list, 10000);
  const flows = useScopedResource(assistantAutomationsApi.overview, 5000);
  const query = search.toString();
  const resume = useAssistantResume({
    scope,
    clientId,
    targetId: target?.id ?? "",
    ready: scopeReady,
    search: query,
    chats: chats.data,
    loading: chats.loading,
    error: chats.error,
    onResume: useCallback(
      (chat: string) => {
        const params = new URLSearchParams(query);
        params.set("chat", chat);
        router.replace(`/assistant?${params}`, { scroll: false });
      },
      [query, router],
    ),
  });
  const id = search.get("chat");
  const automationId = search.get("automation");
  const selectedFlow = flows.data?.automations.find((flow) => flow.id === automationId);
  const viewId = automationId ? `automation:${automationId}` : (id ?? investigation?.key ?? null);
  const [connections, setConnections] = useState(false);
  const [connectionProvider, setConnectionProvider] = useState<AssistantProvider>("claude");
  const [history, setHistory] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [mobileRail, setMobileRail] = useState(false);
  const configTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    try {
      setRailOpen(
        localStorage.getItem("openship.assistant.railCollapsed") !== "true",
      );
    } catch {
      /* diagnostics-ignore: Storage hints are optional; the workspace retains its current authorized state. */
    }
    const media = window.matchMedia("(min-width: 1024px)");
    const resize = () => {
      if (media.matches) setMobileRail(false);
    };
    media.addEventListener("change", resize);
    return () => {
      media.removeEventListener("change", resize);
      if (configTimer.current) clearTimeout(configTimer.current);
    };
  }, []);
  const [access, setAccess] = useState<{
    detail: McpClientDetail;
    request?: PermissionAccessRequest;
  } | null>(null);
  const [savingAccess, setSavingAccess] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  const [provider, setProvider] = useState<AssistantProvider>("claude"),
    [model, setModel] = useState("");
  const [draft, setDraft] = useState("");
  const [outgoing, setOutgoing] = useState<{
    sourceId: string | null;
    conversationId: string | null;
    message: AssistantMessage;
    accepted?: boolean;
    runId?: string | null;
  } | null>(null);
  const currentChat = useRef(viewId);
  currentChat.current = viewId;
  const pending =
    outgoing &&
    !automationId &&
    (outgoing.sourceId === viewId || (!!id && outgoing.conversationId === id))
      ? outgoing
      : null;
  const draftChat = useRef(id);
  const images = useAssistantImages();
  const [chatModel, setChatModel] = useState<{ id: string; value: string } | null>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false),
    pendingRequest = useRef<{ id: string; key: string; conversationId?: string } | null>(null);
  const agents = useScopedResource(assistantApi.providers);
  const conversation = useConversation(id),
    snapshot = conversation.snapshot;
  useEffect(() => {
    // Only remember a conversation after the normal API has verified its ownership.
    if (snapshot?.conversation.id) {
      resume.remember(snapshot.conversation.id);
      if (scopeReady)
        try {
          localStorage.setItem(
            agentChatKey(
              scope,
              clientId,
              target?.id ?? "",
              snapshot.conversation.agentId,
            ),
            snapshot.conversation.id,
          );
        } catch {
          /* diagnostics-ignore: Storage hints are optional; the workspace retains its current authorized state. */
        }
    }
  }, [
    snapshot?.conversation.id,
    snapshot?.conversation.agentId,
    scope,
    scopeReady,
    clientId,
    target?.id,
    resume.remember,
  ]);
  const knownChats = useMemo(
    () => [
      ...new Map([
        ...(savedAgents.data ?? [])
          .flatMap((agent) => agent.tasks)
          .map((chat) => [chat.id, chat] as const),
        ...(chats.data ?? []).map((chat) => [chat.id, chat] as const),
        ...(snapshot ? [[snapshot.conversation.id, snapshot.conversation] as const] : []),
      ]).values(),
    ],
    [chats.data, savedAgents.data, snapshot?.conversation],
  );
  const agentId = snapshot?.conversation.agentId;
  const specialist = useScopedResource(
    useCallback(
      () => (agentId ? assistantAgentsApi.get(agentId) : Promise.resolve(null)),
      [agentId],
    ),
  );
  const agentNavigation = useAgentNavigation();
  const agentRevision = agentNavigation?.revision ?? 0;
  useEffect(() => {
    if (agentRevision) {
      specialist.refresh();
      conversation.refresh();
      savedAgents.refresh();
      flows.refresh();
    }
  }, [agentRevision, specialist.refresh, conversation.refresh, savedAgents.refresh, flows.refresh]);
  useEffect(() => {
    // Navigation from an agent drawer or task card starts with that chat's own draft.
    // Submission and Select transfer/reset it explicitly before changing the URL.
    if (draftChat.current === id) return;
    draftChat.current = id;
    setDraft("");
    images.clear();
    setChatModel(null);
    pendingRequest.current = null;
    setOutgoing((previous) => (previous?.conversationId === id ? previous : null));
  }, [id, images.clear]);
  const preparedInvestigation = useRef<string | null>(null);
  useEffect(() => {
    if (!investigation) {
      preparedInvestigation.current = null;
      return;
    }
    if (preparedInvestigation.current === investigation.key) return;
    preparedInvestigation.current = investigation.key;
    // A shortcut prepares a new, editable request. Loading a URL never starts a turn
    // or expands permissions. Keep the draft when setup/providers refresh.
    setDraft(investigationPrompt(investigation.target, investigationCopy));
    images.clear();
    setChatModel(null);
    pendingRequest.current = null;
    setOutgoing(null);
  }, [investigation, investigationCopy, images.clear]);
  useEffect(() => {
    // Retain the submitted message and activity through a new chat's first snapshot.
    if (
      pending?.accepted &&
      ((snapshot?.conversation.id === pending.conversationId &&
        (snapshot.activity.runId === pending.runId || snapshot.accessChanged)) ||
        conversation.error)
    )
      setOutgoing(null);
  }, [pending, snapshot, conversation.error]);
  const action = useScopedMutation();
  const active = isAssistantActive(snapshot?.activity.state);
  const scopedTask = !!(snapshot?.conversation.agentId || snapshot?.conversation.automationRunId);
  const [automationCanChat, setAutomationCanChat] = useState<{
    id: string;
    allowed: boolean;
  } | null>(null);
  const taskChatAllowed =
    !snapshot?.conversation.automationRunId ||
    (automationCanChat?.id === snapshot.conversation.automationRunId && automationCanChat.allowed);
  const available = agents.data ?? [];
  const currentProvider =
    snapshot?.conversation.provider ??
    available.find(
      (a) => a.id === provider && assistantModelReady(a, model || assistantDefaultModel(a)),
    )?.id ??
    available.find((a) => assistantModelReady(a, assistantDefaultModel(a)))?.id ??
    provider;
  const agent = available.find((a) => a.id === currentProvider);
  const currentModel =
    id && chatModel?.id === id
      ? chatModel.value
      : (snapshot?.conversation.model ?? (model || assistantDefaultModel(agent)));
  const ready = assistantModelReady(agent, currentModel);
  const checkingAgents = agents.loading && !agents.data;
  const needsConnection = !checkingAgents && !agents.error && !ready;
  const reviewAccess = async (request?: PermissionAccessRequest) => {
    const detail = await action.execute(async () => {
      // Finish the current turn before showing the editor. A stop on another API
      // replica may still be in flight; never interpret its acknowledgement as completion.
      if (id) {
        const latest = await assistantApi.get(id);
        if (isAssistantActive(latest.activity.state)) {
          await assistantApi.stop(id);
          const stopped = await assistantApi.get(id);
          if (isAssistantActive(stopped.activity.state))
            throw new Error(
              "Your agent is stopping. Review permissions again once it has stopped.",
            );
        }
      }
      return (await tokensApi.getMcpClient(clientId)).data;
    });
    if (detail) {
      setAccess({ detail, request });
      conversation.refresh();
    }
  };
  const select = (chat: string | null) => {
    resume.cancel();
    currentChat.current = chat;
    draftChat.current = chat;
    setHistory(false);
    setMobileRail(false);
    setConnections(false);
    setDraft("");
    images.clear();
    setChatModel(null);
    pendingRequest.current = null;
    setOutgoing(null);
    router.replace(chat ? `/assistant?chat=${encodeURIComponent(chat)}` : "/assistant?new=1", {
      scroll: false,
    });
  };
  const submit = async (continuation?: string): Promise<boolean> => {
    if (
      sending.current ||
      resume.resolving ||
      action.busy ||
      pending ||
      (active && !scopedTask) ||
      !taskChatAllowed ||
      access ||
      (!continuation && !draft.trim() && !images.images.length) ||
      (!continuation && images.pending) ||
      (!continuation && images.images.length > 0 && !agent?.imageInput) ||
      !ready ||
      snapshot?.accessChanged
    )
      return false;
    sending.current = true;
    const submittedDraft = { text: draft, images: images.images };
    const message = continuation ?? draft.trim();
    const attachments = continuation ? [] : images.images.map(({ id: _id, ...image }) => image);
    const key = JSON.stringify([
      currentProvider,
      currentModel,
      message,
      continuation ? [] : images.images.map((image) => image.id),
    ]);
    const request =
      pendingRequest.current?.key === key
        ? pendingRequest.current
        : { id: crypto.randomUUID(), key, conversationId: id ?? undefined };
    pendingRequest.current = request;
    setOutgoing({
      sourceId: viewId,
      conversationId: id,
      message: {
        id: active ? `input:${request.id}` : `user-${request.id}`,
        chatId: id ?? "",
        role: "user",
        text: message,
        ...(attachments.length ? { attachments } : {}),
        createdAt: new Date().toISOString(),
      },
    });
    // The sent message now belongs to the transcript. Clear the composer before
    // creating a conversation or waiting for the agent's acknowledgement.
    if (!continuation) {
      setDraft("");
      images.clear();
    }
    try {
      const result = await action.execute(async () => {
        const chatId =
          request.conversationId ??
          (await assistantApi.create({ provider: currentProvider, model: currentModel })).id;
        request.conversationId = chatId;
        const activity = active
          ? await assistantApi.message(chatId, { requestId: request.id, message })
          : await assistantApi.start(chatId, {
              requestId: request.id,
              message,
              model: currentModel,
              ...(attachments.length ? { attachments } : {}),
            });
        // A response for a chat we left must not replace the newly selected chat.
        if (pendingRequest.current !== request || currentChat.current !== viewId) return activity;
        if (chatId === id && !activity.reset) {
          conversation.apply(activity);
          setOutgoing(null);
        } else {
          setOutgoing((previous) =>
            previous
              ? {
                  ...previous,
                  conversationId: chatId,
                  accepted: true,
                  runId: activity.runId,
                }
              : null,
          );
          draftChat.current = chatId;
          router.replace(`/assistant?chat=${encodeURIComponent(chatId)}`, { scroll: false });
        }
        conversation.refresh();
        chats.refresh();
        return activity;
      });
      if (
        pendingRequest.current !== request ||
        (currentChat.current !== viewId && currentChat.current !== request.conversationId)
      )
        return false;
      if (!continuation && (!result || result.state === "error")) {
        setDraft(submittedDraft.text);
        images.restore(submittedDraft.images);
      }
      if (result) pendingRequest.current = null;
      else setOutgoing(null);
      return !!result && result.state !== "error";
    } finally {
      sending.current = false;
    }
  };
  const openAgent = async (selectedId: string | null, fresh = false) => {
    const selected = selectedId
      ? savedAgents.data?.find((item) => item.id === selectedId && !item.archived)
      : null;
    if (selectedId && !selected) {
      action.setError("This agent is no longer available. Refresh the agent list.");
      return;
    }
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(
        agentChatKey(scope, clientId, target?.id ?? "", selectedId),
      );
    } catch {
      /* diagnostics-ignore: Storage hints are optional; the workspace retains its current authorized state. */
    }
    const previous = fresh ? null : agentResumeChat(knownChats, selectedId, remembered);
    if (previous) return select(previous.id);
    if (!selected) return select(null);
    const from = currentChat.current;
    const chat = await action.execute(() =>
      assistantApi.create({
        agentId: selected.id,
        provider: selected.provider,
        model: selected.model,
      }),
    );
    if (chat && currentChat.current === from) {
      savedAgents.refresh();
      chats.refresh();
      select(chat.id);
    }
  };
  const newChat = () => {
    void openAgent(automationId ? (selectedFlow?.agentId ?? null) : (agentId ?? null), true);
  };
  const toggleRail = () => {
    if (!window.matchMedia("(min-width: 1024px)").matches) return setMobileRail(true);
    setRailOpen((open) => {
      try {
        localStorage.setItem("openship.assistant.railCollapsed", String(open));
      } catch {
        /* diagnostics-ignore: Storage hints are optional; the workspace retains its current authorized state. */
      }
      return !open;
    });
  };
  const configureAgent = (href: string) => {
    const navigate = () => (agentNavigation ? agentNavigation.navigate(href) : router.push(href));
    if (mobileRail) {
      setMobileRail(false);
      configTimer.current = setTimeout(navigate, 240);
    } else navigate();
  };
  const selectAutomation = (flowId: string) => {
    resume.cancel();
    setMobileRail(false);
    setHistory(false);
    currentChat.current = `automation:${flowId}`;
    const params = new URLSearchParams({ ...(id ? { chat: id } : {}), automation: flowId });
    router.replace(`/assistant?${params}`, { scroll: false });
  };
  const continueWithCurrentAccess = () => {
    const message =
      [...(snapshot?.messages ?? [])].reverse().find((item) => item.role === "user")?.text ?? "";
    // A fresh conversation receives the current grant. Retain the user's request
    // as an editable draft; never replay a previously denied operation on save.
    setProvider(currentProvider);
    setModel(currentModel);
    select(null);
    setDraft(message);
    requestAnimationFrame(() => composerInput.current?.focus());
  };
  const openConnections = (selected: AssistantProvider = currentProvider) => {
    setConnectionProvider(selected);
    setConnections(true);
  };
  const rail = (
    <AssistantRail
      agents={savedAgents.data ?? []}
      chats={knownChats}
      overview={flows.data}
      selectedAgentId={
        snapshot?.conversation.agentId ?? knownChats.find((chat) => chat.id === id)?.agentId
      }
      selectedAutomationId={
        automationId ??
        flows.data?.runs.find((run) => run.conversationId === id)?.automationId ??
        null
      }
      loading={savedAgents.loading || flows.loading}
      error={savedAgents.error ?? flows.error ?? action.error}
      busy={action.busy || !!pending || !scopeReady}
      onAgent={(selected) => void openAgent(selected)}
      onAutomation={selectAutomation}
      onConfigure={configureAgent}
      onManageAutomations={() => {
        setMobileRail(false);
        router.push("/assistant?tab=automations");
      }}
      onRetry={() => {
        savedAgents.refresh();
        chats.refresh();
        flows.refresh();
      }}
    />
  );
  const composer = (
    <div className="mx-auto w-full max-w-3xl shrink-0">
      {(action.error || conversation.error || agents.error) && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {action.error || conversation.error || agents.error}
          <button
            className="ms-2 underline"
            onClick={() => {
              conversation.refresh();
              agents.refresh();
            }}
          >
            Retry
          </button>
        </p>
      )}
      {snapshot?.accessChanged && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl bg-card p-4 text-sm text-muted-foreground">
          <span className="min-w-48 flex-1">
            <span className="block font-medium text-foreground">Your access has changed</span>
            Continue in a new chat with your current access. Your last request will be ready to
            send.
          </span>
          <Button size="sm" variant="secondary" onClick={continueWithCurrentAccess}>
            Continue in new chat
            <Icon name="arrow-right" />
          </Button>
        </div>
      )}
      {snapshot && (
        <AssistantQuestions
          key={snapshot.conversation.id}
          snapshot={snapshot}
          active={active}
          onAnswered={conversation.refresh}
        />
      )}
      {snapshot?.conversation.chatThreadId && (
        <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <Icon name="message" className="size-3.5 shrink-0" />
          Continue here or in your chat app.
        </p>
      )}
      {!snapshot?.accessChanged && (
        <AssistantComposer
          inputRef={composerInput}
          compact={!!id || !!pending || resume.resolving}
          images={images.images}
          onImages={(files) => void images.add(files)}
          onRemoveImage={images.remove}
          imageError={images.error}
          imagesPending={images.pending}
          imagesSupported={agent?.imageInput === true}
          value={draft}
          onChange={setDraft}
          onSend={() => void submit()}
          onStop={() =>
            void action.execute(async () => {
              await assistantApi.stop(id!);
              conversation.refresh();
              chats.refresh();
            })
          }
          active={active || !!pending}
          canMessageWhileActive={scopedTask && taskChatAllowed}
          busy={action.busy || !!pending}
          disabled={
            resume.resolving || !!snapshot?.accessChanged || (!!id && !snapshot) || !taskChatAllowed
          }
          canSend={ready && !access}
          placeholder={
            !checkingAgents && !ready
              ? "Connect your agent to continue this conversation…"
              : id || pending
                ? "Ask a follow-up…"
                : undefined
          }
          controls={
            <>
              {id ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => openConnections()}
                  className="h-9 shrink-0 gap-2 rounded-full px-2 text-[13px] font-normal text-foreground"
                >
                  <Icon name={currentProvider} />
                  {ASSISTANT_PROVIDER_LABELS[currentProvider]}
                  {!ready && !agents.loading && (
                    <span
                      className="size-1.5 rounded-full bg-warning"
                      aria-label="Connection needed"
                    />
                  )}
                </Button>
              ) : checkingAgents ? (
                <span
                  role="status"
                  className="inline-flex h-9 max-w-[52%] shrink-0 items-center gap-2 px-2 text-[13px] text-muted-foreground"
                >
                  <Icon name="spinner" className="size-3.5 motion-safe:animate-spin" />
                  Connecting…
                </span>
              ) : (
                <CustomSelect
                  aria-label="Agent"
                  placeholder="Choose agent"
                  value={currentProvider}
                  options={available.map((a) => ({
                    value: a.id,
                    label: ASSISTANT_PROVIDER_LABELS[a.id],
                    description: assistantModelReady(a, assistantDefaultModel(a))
                      ? "Connected"
                      : "Connect your account",
                    icon: <Icon name={a.id} className="size-4" />,
                  }))}
                  onChange={(value) => {
                    const chosen = available.find((a) => a.id === value);
                    if (!assistantModelReady(chosen, assistantDefaultModel(chosen)))
                      openConnections(value as AssistantProvider);
                    else {
                      setProvider(value as AssistantProvider);
                      setModel("");
                    }
                  }}
                  footerAction={{
                    label: "Manage connections",
                    icon: <Icon name="settings" className="size-4" />,
                    onClick: () => openConnections(),
                  }}
                  disabled={action.busy || !!pending || !available.length}
                  variant="filled"
                  triggerClassName="h-9 gap-1.5 rounded-full bg-transparent px-2 text-[13px] hover:bg-muted/60 [&>svg]:size-3"
                  className="w-auto max-w-[52%] shrink-0"
                />
              )}
              <CustomSelect
                aria-label="Model"
                value={currentModel}
                placeholder={checkingAgents ? "Loading models…" : "Choose model"}
                options={[
                  ...(agent?.authStatus.configured ? [{ value: "", label: "Default model" }] : []),
                  ...(agent?.models ?? []).map((m) => ({ value: m.id, label: m.label })),
                  ...(currentModel && !agent?.models.some((m) => m.id === currentModel)
                    ? [{ value: currentModel, label: currentModel }]
                    : []),
                ]}
                onChange={(value) => (id ? setChatModel({ id, value }) : setModel(value))}
                disabled={
                  !!snapshot?.conversation.agentId ||
                  active ||
                  action.busy ||
                  !!pending ||
                  checkingAgents ||
                  !agent?.models.length
                }
                variant="filled"
                triggerClassName="h-9 gap-1.5 rounded-full bg-transparent px-2 text-[13px] hover:bg-muted/60 [&>svg]:size-3"
                className="min-w-0 max-w-52"
              />
            </>
          }
        />
      )}
    </div>
  );
  return (
    <>
      <div className="flex min-h-0 flex-1 gap-5 xl:gap-7">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="mb-5 flex shrink-0 items-center gap-2 sm:gap-3">
            <div className="min-w-0 flex-1">
              {automationId ? (
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-card text-muted-foreground">
                    <Icon name="workflow" className="size-4" />
                  </span>
                  <h1 className="min-w-0 truncate text-xl font-medium">
                    {selectedFlow?.name ?? "Automation"}
                  </h1>
                </div>
              ) : (
                <AssistantChatIdentity
                  conversation={snapshot?.conversation}
                  agent={specialist.data}
                  loading={resume.resolving || (!!id && !snapshot)}
                />
              )}
            </div>
            <div className="flex items-center gap-1 sm:gap-2">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Toggle AI Agents navigation"
                title="Toggle navigation"
                onClick={toggleRail}
                className="shrink-0"
              >
                <Icon
                  name={railOpen ? "sidebar-close" : "sidebar-open"}
                  className="-scale-x-100 rtl:scale-x-100"
                />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                aria-label="Conversations"
                title="Conversations"
                onClick={() => setHistory(true)}
              >
                <Icon name="history" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="New chat"
                title="New chat"
                disabled={
                  action.busy || !!pending || !scopeReady || (savedAgents.loading && !!agentId)
                }
                onClick={newChat}
              >
                <Icon name="plus" />
              </Button>
              <DropdownMenu
                align="right"
                triggerLabel="Assistant settings"
                actions={[
                  ...(agentId && !automationId
                    ? [
                        {
                          id: "configure-agent",
                          label: "Agent settings & access",
                          icon: <Icon name="settings" className="size-4" />,
                          onClick: () => configureAgent(`/assistant/agents/${agentId}/edit`),
                        },
                      ]
                    : []),
                  {
                    id: "manage-agents",
                    label: "Manage agents",
                    icon: <Icon name="bot" className="size-4" />,
                    onClick: () => configureAgent("/assistant/agents"),
                  },
                  {
                    id: "connections",
                    label: "Connections",
                    icon: <Icon name="plug" className="size-4" />,
                    onClick: () => openConnections(),
                  },
                  {
                    id: "settings",
                    label: "Assistant settings",
                    icon: <Icon name="settings" className="size-4" />,
                    onClick: () => router.push("/settings?tab=assistant"),
                  },
                  {
                    id: "chat-apps",
                    label: "Chat apps",
                    icon: <Icon name="message" className="size-4" />,
                    onClick: () => router.push("/settings?tab=chat-apps"),
                  },
                  {
                    id: "access",
                    label: "Review permissions",
                    icon: <Icon name="shield" className="size-4" />,
                    onClick: () => void reviewAccess(),
                  },
                  {
                    id: "audit",
                    label: "View audit trail",
                    icon: <Icon name="clipboard-list" className="size-4" />,
                    onClick: () =>
                      router.push(
                        `/audit?source=mcp&client=${encodeURIComponent(`oauth:${clientId}`)}`,
                      ),
                  },
                  {
                    id: "disable",
                    label: "Disable assistant",
                    icon: <Icon name="power" className="size-4" />,
                    onClick: () =>
                      void action.execute(async () => {
                        await assistantApi.disable();
                        onDisabled();
                      }),
                  },
                ]}
              />
            </div>
          </header>
          {automationId ? (
            <AssistantAutomationDetail
              key={automationId}
              clientId={clientId}
              agentName={
                savedAgents.data?.find((agent) => agent.id === selectedFlow?.agentId)?.name
              }
              flow={selectedFlow}
              runs={(flows.data?.runs ?? []).filter((run) => run.automationId === automationId)}
              paused={flows.data?.paused ?? false}
              loading={flows.loading}
              error={flows.error}
              onChat={select}
              onRefresh={flows.refresh}
            />
          ) : (
            <div className="flex min-h-0 flex-1">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {!resume.resolving &&
                !pending &&
                (!id ||
                  (snapshot && !snapshot.messages.length && !snapshot.accessChanged && !active)) ? (
                  <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                    <div className="mx-auto my-auto w-full max-w-3xl py-8 sm:py-10 [@media(max-height:640px)]:py-2">
                      <div className="mb-8 px-1 text-center [@media(max-height:640px)]:mb-4">
                        {agentId && (
                          <AgentAvatar
                            icon={specialist.data?.icon}
                            agentId={specialist.data?.id}
                            className="mb-5 size-16"
                          />
                        )}
                        <h2 className="text-balance text-3xl font-medium leading-tight tracking-[-0.03em] text-foreground sm:text-4xl lg:text-[40px]">
                          {agentId
                            ? (specialist.data?.name ?? "Your agent")
                            : investigation
                              ? investigation.target.kind === "deployment"
                                ? investigationCopy.deploymentTitle
                                : investigation.target.kind === "monitoring"
                                  ? investigationCopy.reportTitle
                                  : investigation.target.intent === "fix"
                                    ? investigationCopy.fixTitle
                                    : investigationCopy.issueTitle
                              : "What are we working on?"}
                        </h2>
                        <p className="mx-auto mt-4 max-w-xl text-pretty text-[15px] leading-7 text-muted-foreground [@media(max-height:500px)]:hidden">
                          {agentId
                            ? (specialist.data?.purpose ??
                              "Describe what you’d like this agent to work on.")
                            : investigation
                              ? investigationCopy.description
                              : "A new deploy, a tricky log, or a check on your apps. Start here."}
                        </p>
                      </div>
                      {!needsConnection ? (
                        composer
                      ) : (
                        <div className="grid gap-3 sm:grid-cols-2">
                          {available.map((a) => (
                            <button
                              key={a.id}
                              onClick={() => openConnections(a.id)}
                              className="group flex items-center gap-4 rounded-2xl bg-card p-5 text-start transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                            >
                              <Icon name={a.id} className="size-7 shrink-0" />
                              <span className="flex-1">
                                <span className="block text-sm font-medium">
                                  {ASSISTANT_PROVIDER_LABELS[a.id]}
                                </span>
                                <span className="mt-1 block text-xs text-muted-foreground">
                                  {!a.available
                                    ? "View setup options"
                                    : a.authMethods.some((method) => method.existing)
                                      ? "Use your existing connection"
                                      : "Connect your account"}
                                </span>
                              </span>
                              <Icon
                                name="arrow-right"
                                className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                              />
                            </button>
                          ))}
                          {agents.error && (
                            <p role="alert" className="text-sm text-danger sm:col-span-2">
                              {agents.error}
                              <button className="ms-2 underline" onClick={agents.refresh}>
                                Retry
                              </button>
                            </p>
                          )}
                        </div>
                      )}
                      {!needsConnection && !agentId && !investigation && (
                        <div className="mt-6 flex flex-wrap justify-center gap-2 [@media(max-height:500px)]:hidden">
                          {suggestions.map((s) => (
                            <button
                              key={s.title}
                              onClick={() => {
                                setDraft(s.prompt);
                                composerInput.current?.focus();
                              }}
                              className="flex items-center gap-2 rounded-full px-3.5 py-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                            >
                              <Icon name={s.icon} className="size-4" />
                              {s.title}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <AssistantConversationLayout
                    footer={
                      <>
                        {snapshot?.conversation.automationRunId && (
                          <AutomationConversationStatus
                            key={snapshot.conversation.automationRunId}
                            runId={snapshot.conversation.automationRunId}
                            onChatAvailability={setAutomationCanChat}
                          />
                        )}
                        {(!snapshot?.accessChanged || snapshot.messages.length > 0) && (
                          <div className="shrink-0 pt-3 pb-1">{composer}</div>
                        )}
                      </>
                    }
                  >
                    {snapshot?.accessChanged && !snapshot.messages.length ? (
                      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto py-6 text-center">
                        <Icon name="shield" className="mb-4 size-7 text-muted-foreground" />
                        <h2 className="text-xl font-medium">
                          Start fresh with your updated access
                        </h2>
                        <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                          Your permissions changed. Open a new chat to continue with the access you
                          approved.
                        </p>
                        <Button className="mt-5 shrink-0" onClick={newChat}>
                          <Icon name="plus" />
                          New chat
                        </Button>
                      </div>
                    ) : snapshot || pending ? (
                      <AssistantTranscript
                        key={id}
                        clientId={clientId}
                        reviewingAccess={action.busy || !!access}
                        accessChanged={snapshot?.accessChanged}
                        onReviewAccess={(request) => void reviewAccess(request)}
                        actionDisabled={!ready || action.busy || !!access || !taskChatAllowed}
                        onContinue={(message) => submit(message)}
                        messages={
                          pending &&
                          !snapshot?.messages.some((message) => message.id === pending.message.id)
                            ? [...(snapshot?.messages ?? []), pending.message]
                            : (snapshot?.messages ?? [])
                        }
                        automated={!!snapshot?.conversation.automationRunId}
                        active={active}
                        pending={pending ? (pending.accepted ? "Working" : "Sending") : undefined}
                        error={snapshot?.activity.error}
                        hasMore={snapshot?.hasMore}
                        onEarlier={async () => {
                          if (!id || !snapshot?.before) return;
                          await action.execute(async () => {
                            const earlier = await assistantApi.history(id, snapshot.before!);
                            conversation.setSnapshot((previous) =>
                              previous?.conversation.id === id
                                ? {
                                    ...previous,
                                    messages: [...earlier.messages, ...previous.messages],
                                    hasMore: earlier.hasMore,
                                    before: earlier.before,
                                  }
                                : previous,
                            );
                          });
                        }}
                      />
                    ) : (
                      <ConversationSkeleton />
                    )}
                  </AssistantConversationLayout>
                )}
              </div>
            </div>
          )}
        </div>
        {railOpen && (
          <aside className="hidden w-[340px] shrink-0 border-s border-border/40 ps-4 lg:block xl:ps-5">
            {rail}
          </aside>
        )}
      </div>
      <AssistantDialog
        label="AI connections"
        keepMounted
        isOpen={connections}
        onClose={() => setConnections(false)}
        width="940px"
        maxWidth="calc(100vw - 24px)"
        maxHeight="calc(100dvh - 24px)"
        overflow="auto"
      >
        <AgentConnections
          agents={available}
          hostName={target?.kind === "local" ? "this computer" : target?.name}
          selected={connectionProvider}
          onSelect={setConnectionProvider}
          onRefresh={agents.refresh}
          loading={agents.loading}
          error={agents.error}
        />
      </AssistantDialog>
      <Drawer
        label="Conversations"
        isOpen={history}
        onClose={() => setHistory(false)}
        closeLabel="Close conversations"
        width="420px"
      >
        <div className="flex shrink-0 items-center gap-3 px-5 pb-4 pe-16 pt-5">
          <h2 className="min-w-0 flex-1 text-lg font-medium">Conversations</h2>
          <Button variant="ghost" size="sm" disabled={action.busy || !!pending} onClick={newChat}>
            <Icon name="plus" className="!size-3.5" />
            New chat
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-4">
          <ConversationHistory
            chats={knownChats}
            selected={id}
            loading={chats.loading}
            error={chats.error}
            busy={action.busy}
            onSelect={select}
            onDelete={setDeleting}
            onRetry={chats.refresh}
          />
        </div>
      </Drawer>
      <Drawer
        label="AI Agents navigation"
        isOpen={mobileRail}
        onClose={() => setMobileRail(false)}
        closeLabel="Close navigation"
        width="340px"
      >
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-4 pt-14">{rail}</div>
      </Drawer>
      <AssistantDialog
        label="Delete conversation"
        closable={!action.busy}
        isOpen={!!deleting}
        onClose={() => {
          if (!action.busy) setDeleting(null);
        }}
        width="460px"
        maxWidth="94vw"
      >
        <div className="space-y-5 p-6">
          <h2 className="text-lg font-medium">Delete this conversation?</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            “{deleting?.title}” and its local history will be removed. A running turn will be
            stopped.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={action.busy} onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={action.busy}
              onClick={() =>
                void action.execute(async () => {
                  if (!deleting) return;
                  await assistantApi.remove(deleting.id);
                  resume.forget(deleting.id);
                  chats.refresh();
                  if (id === deleting.id) select(null);
                  setDeleting(null);
                })
              }
            >
              Delete conversation
            </Button>
          </div>
          {action.error && (
            <p role="alert" className="text-sm text-danger">
              {action.error}
            </p>
          )}
        </div>
      </AssistantDialog>
      <AssistantDialog
        label="Assistant permissions"
        isOpen={!!access}
        onClose={() => setAccess(null)}
        closable={!savingAccess}
        width="1120px"
        maxWidth="96vw"
        height="min(850px, calc(100dvh - 32px))"
        maxHeight="calc(100dvh - 32px)"
        overflow="hidden"
      >
        {access && (
          <AccessCopyProvider value={ASSISTANT_ACCESS_COPY}>
            <McpAccessEditor
              detail={access.detail}
              layout="dialog"
              onBusyChange={setSavingAccess}
              notice={
                access.request && (
                  <div className="space-y-3 rounded-xl bg-card p-4">
                    <p className="text-sm font-medium">Your agent is requesting access</p>
                    <AccessRequestSummary request={access.request} />
                  </div>
                )
              }
              onClose={() => setAccess(null)}
              onSaved={() => {
                setAccess(null);
                conversation.refresh();
              }}
            />
          </AccessCopyProvider>
        )}
      </AssistantDialog>
    </>
  );
}
