"use client";
import { useEffect, useId, useState } from "react";
import {
  ASSISTANT_PROVIDER_LABELS,
  assistantFieldInput,
  assistantModelReady,
  type AssistantProviderInfo,
  type AssistantProvider,
  type AuthState,
} from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { assistantApi } from "@/lib/api/assistant";
import { getApiErrorMessage } from "@/lib/api/client";
import { useScopedMutation } from "@/hooks/use-scoped-resource";
import { AssistantFields } from "./AssistantFields";
import { CustomApiConnection } from "./CustomApiConnection";

export type AssistantConnectionSelection = AssistantProvider | "custom";

/** One set of connection forms, presented inline in chat or inside settings. */
export function AgentConnections({
  agents,
  hostName,
  selected,
  onSelect,
  onRefresh,
  loading,
  error,
  inline = false,
  onBack,
  onUse,
  useLabel = "Use this connection",
}: {
  agents: AssistantProviderInfo[];
  hostName?: string;
  selected: AssistantConnectionSelection;
  onSelect(selection: AssistantConnectionSelection): void;
  onRefresh(): void;
  loading: boolean;
  error: string | null;
  inline?: boolean;
  onBack?(): void;
  onUse?(provider: AssistantProvider, model: string): void;
  useLabel?: string;
}) {
  const id = useId();
  const installing = agents.some((agent) => agent.setup?.state === "installing");
  const codex = agents.find((agent) => agent.id === "codex");
  const choices = [
    ...agents.map((agent) => ({
      id: agent.id as AssistantConnectionSelection,
      label: ASSISTANT_PROVIDER_LABELS[agent.id],
      icon: agent.id,
      status:
        agent.setup?.state === "installing"
          ? "Setting up…"
          : agent.authStatus.configured
            ? "Connected"
            : !agent.available
              ? "Setup required"
              : agent.authMethods.some((method) => method.existing)
                ? "Connection found"
                : null,
    })),
    {
      id: "custom" as const,
      label: "Custom API",
      icon: "code" as const,
      status: null,
    },
  ];
  const active = choices.some((choice) => choice.id === selected) ? selected : choices[0].id;
  useEffect(() => {
    if (!installing || loading || error) return;
    const timer = setTimeout(onRefresh, 2000);
    return () => clearTimeout(timer);
  }, [installing, agents, loading, error, onRefresh]);
  return (
    <section
      className={inline ? "mx-auto w-full max-w-3xl py-6 sm:py-8" : "p-5 sm:p-8"}
      aria-label="AI connections"
    >
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2
            className={
              inline
                ? "text-2xl font-medium tracking-tight text-foreground"
                : "text-xl font-medium text-foreground"
            }
          >
            {inline ? "Connect your AI" : "AI connections"}
          </h2>
          <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
            Choose an account or connect your own model.
          </p>
        </div>
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            <Icon name="arrow-left" />
            Back to chat
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      {loading && !agents.length && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          Checking your installed agents…
        </p>
      )}
      <div className="rounded-2xl bg-card p-4 sm:p-6">
        <div className="mb-6 border-b border-border/50 pb-4">
          <div role="tablist" aria-label="Agent connections" className="flex flex-wrap gap-2">
            {choices.map((choice, index) => (
              <button
                key={choice.id}
                id={`${id}-tab-${choice.id}`}
                type="button"
                role="tab"
                aria-selected={active === choice.id}
                aria-controls={`${id}-panel-${choice.id}`}
                tabIndex={active === choice.id ? 0 : -1}
                onClick={() => onSelect(choice.id)}
                onKeyDown={(event) => {
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? choices.length - 1
                        : ["ArrowRight", "ArrowDown"].includes(event.key)
                          ? (index + 1) % choices.length
                          : ["ArrowLeft", "ArrowUp"].includes(event.key)
                            ? (index - 1 + choices.length) % choices.length
                            : null;
                  if (next === null) return;
                  event.preventDefault();
                  onSelect(choices[next].id);
                  document.getElementById(`${id}-tab-${choices[next].id}`)?.focus();
                }}
                className={`flex min-w-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${active === choice.id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
              >
                <Icon name={choice.icon} className="size-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block font-medium text-foreground">{choice.label}</span>
                  {choice.status && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {choice.status}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="min-w-0">
          {agents.map((agent) => (
            <div
              key={agent.id}
              id={`${id}-panel-${agent.id}`}
              role="tabpanel"
              aria-labelledby={`${id}-tab-${agent.id}`}
              hidden={active !== agent.id}
            >
              <AgentConnection
                info={agent}
                refresh={onRefresh}
                onUse={onUse ? () => onUse(agent.id, "") : undefined}
                useLabel={useLabel}
              />
            </div>
          ))}
          <div
            id={`${id}-panel-custom`}
            role="tabpanel"
            aria-labelledby={`${id}-tab-custom`}
            hidden={active !== "custom"}
          >
            <CustomApiConnection
              available={!!codex?.customApiAvailable}
              onSaved={(model) => {
                onRefresh();
                onUse?.("codex", model);
              }}
            />
          </div>
        </div>
      </div>
      {!!codex?.customProviders?.length && (
        <section aria-label="Saved custom models" className="mt-6">
          <h3 className="mb-3 text-xs font-medium text-muted-foreground">Your custom models</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {codex.customProviders.flatMap((provider) =>
              provider.models.map((model) => (
                <div
                  key={`${provider.id}/${model}`}
                  className="flex min-w-0 items-center gap-3 rounded-xl bg-card px-4 py-3"
                >
                  <Icon name="code" className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{model}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {provider.name} · {provider.hasKey ? "Connected" : "API key needed"}
                    </p>
                  </div>
                  {onUse && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!assistantModelReady(codex, `${provider.id}/${model}`)}
                      onClick={() => onUse("codex", `${provider.id}/${model}`)}
                      aria-label={`Use ${model}`}
                    >
                      Use
                      <Icon name="arrow-right" />
                    </Button>
                  )}
                </div>
              )),
            )}
          </div>
        </section>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-3 text-xs leading-5 text-muted-foreground">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Icon name="lock" className="size-3.5 shrink-0" />
          Connections stay on {hostName || "the assistant host"}.
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={onRefresh}
          aria-label="Check agent connections"
        >
          <Icon name="refresh" className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>
    </section>
  );
}

function AgentConnection({
  info,
  refresh,
  onUse,
  useLabel,
}: {
  info: AssistantProviderInfo;
  refresh(): void;
  onUse?(): void;
  useLabel: string;
}) {
  const [chosenMethod, setMethod] = useState<string | null>(null);
  const [state, setState] = useState<AuthState | null>(null),
    [values, setValues] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [pollError, setPollError] = useState<string | null>(null);
  const action = useScopedMutation();
  const chatgptMethod =
    info.id === "codex"
      ? info.authMethods.find((m) => m.id === "login" || m.id === "loginDevice")
      : undefined;
  const method =
    chosenMethod ??
    info.authMethods.find((method) => method.existing)?.id ??
    chatgptMethod?.id ??
    info.authMethods[0]?.id ??
    "";
  const selectedMethod = info.authMethods.find((m) => m.id === method);
  const signInHelp =
    info.id === "codex" && selectedMethod?.id === "loginDevice"
      ? "Cloud and remote servers use a one-time code. Open the sign-in page in your browser, enter the code, then return here. Enable device code login in your ChatGPT security settings if prompted."
      : info.id === "codex" && selectedMethod?.id === "login"
        ? "On this desktop, sign in with ChatGPT in your browser, then return here."
        : selectedMethod?.help;
  useEffect(() => {
    if (state?.status !== "pending" || !state.flowId || pollError) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await assistantApi.authStep(info.id, { _flowId: state.flowId! });
        if (!active) return;
        setState(next);
        if (next.status === "complete") {
          setValues({});
          refresh();
        } else if (next.status === "pending") timer = setTimeout(() => void poll(), 2000);
      } catch (error) {
        if (active) setPollError(getApiErrorMessage(error));
      }
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [info.id, state?.flowId, state?.status, pollError, refresh]);
  const fields = state?.fields ?? selectedMethod?.fields ?? [];
  const authUrl = state?.url && /^https?:\/\//i.test(state.url) ? state.url : null;
  return (
    <section className="min-w-0" aria-label={`${ASSISTANT_PROVIDER_LABELS[info.id]} connection`}>
      {info.issue && <p className="mt-4 text-sm leading-6 text-muted-foreground">{info.issue}</p>}
      {!info.available && info.setup && (
        <Button
          className="mt-5 gap-2"
          disabled={action.busy || info.setup.state === "installing"}
          onClick={async () => {
            if (await action.execute(() => assistantApi.setupProvider(info.id))) refresh();
          }}
        >
          {action.busy || info.setup.state === "installing" ? (
            <>
              <Icon name="spinner" className="size-4 animate-spin motion-reduce:animate-none" />{" "}
              Setting up…
            </>
          ) : info.setup.state === "failed" ? (
            "Retry setup"
          ) : (
            `Set up ${ASSISTANT_PROVIDER_LABELS[info.id]}`
          )}
        </Button>
      )}
      {info.available && (
        <div className="space-y-5">
          {info.authStatus.configured ? (
            <>
              <p className="text-sm leading-6 text-muted-foreground">
                {info.authStatus.detail ||
                  "Your saved connection is ready. Your agent can only use the tools and resources you authorize."}
              </p>
              {onUse && (
                <Button onClick={onUse} disabled={action.busy}>
                  {useLabel}
                  <Icon name="arrow-right" />
                </Button>
              )}
              {info.fields.length > 0 && (
                <details>
                  <summary className="cursor-pointer rounded-lg py-2 text-sm text-muted-foreground">
                    Agent settings
                  </summary>
                  <div className="mt-4 space-y-4">
                    <AssistantFields
                      fields={info.fields}
                      values={{ ...info.settings, ...settings }}
                      onChange={setSettings}
                      disabled={action.busy}
                    />
                    <Button
                      variant="secondary"
                      disabled={action.busy || !Object.keys(settings).length}
                      onClick={() =>
                        void action.execute(async () => {
                          await assistantApi.configure(info.id, settings);
                          setSettings({});
                          refresh();
                        })
                      }
                    >
                      Save settings
                    </Button>
                  </div>
                </details>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={action.busy}
                onClick={() =>
                  void action.execute(async () => {
                    await assistantApi.logout(info.id);
                    setState(null);
                    setValues({});
                    refresh();
                  })
                }
              >
                Disconnect from OpenShip
              </Button>
            </>
          ) : (
            <>
              <div
                role="group"
                aria-label={`Sign-in method for ${ASSISTANT_PROVIDER_LABELS[info.id]}`}
                className="flex flex-wrap gap-2"
              >
                {info.authMethods.map((option) => (
                  <Button
                    key={option.id}
                    type="button"
                    size="sm"
                    variant={method === option.id ? "secondary" : "ghost"}
                    aria-pressed={method === option.id}
                    disabled={action.busy || state?.status === "pending"}
                    onClick={() => {
                      if (option.id === method) return;
                      setMethod(option.id);
                      setState(null);
                      setPollError(null);
                      setValues({});
                      action.setError(null);
                    }}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
              {!state && method && (
                <>
                  {signInHelp && (
                    <p className="text-xs leading-5 text-muted-foreground">{signInHelp}</p>
                  )}
                  <Button
                    variant="secondary"
                    disabled={action.busy}
                    onClick={() =>
                      void action.execute(async () => {
                        const next = await assistantApi.authBegin(info.id, method);
                        setState(next);
                        setPollError(null);
                        if (next.status === "complete") refresh();
                      })
                    }
                  >
                    {action.busy
                      ? "Connecting…"
                      : selectedMethod?.existing
                        ? "Use existing connection"
                        : "Continue"}
                  </Button>
                </>
              )}
              {state?.message && (
                <p className="text-sm leading-6 text-muted-foreground">{state.message}</p>
              )}
              {authUrl && (
                <a
                  href={authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm underline underline-offset-4"
                >
                  Open sign-in page
                  <Icon name="arrow-up-right" className="size-3.5" />
                </a>
              )}
              {state?.code && (
                <div className="rounded-xl bg-background px-4 py-3 font-mono text-lg tracking-wide select-all">
                  {state.code}
                </div>
              )}
              {state?.status === "pending" && (
                <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Icon name="spinner" className="size-3.5 animate-spin" />
                  Waiting for sign-in…
                </p>
              )}
              {state?.status === "needs_input" && (
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action.execute(async () => {
                      const next = await assistantApi.authStep(info.id, {
                        ...assistantFieldInput(fields, values),
                        ...(state.flowId ? { _flowId: state.flowId } : {}),
                      });
                      setState(next);
                      if (next.status === "complete") {
                        setValues({});
                        refresh();
                      }
                    });
                  }}
                >
                  <AssistantFields
                    fields={fields}
                    values={values}
                    onChange={setValues}
                    disabled={action.busy}
                  />
                  <Button disabled={action.busy}>{action.busy ? "Connecting…" : "Connect"}</Button>
                </form>
              )}
              {state && state.status !== "complete" && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={action.busy}
                  onClick={() =>
                    void action.execute(async () => {
                      if (state.flowId)
                        await assistantApi.authStep(info.id, {
                          _flowId: state.flowId,
                          _action: "cancel",
                        });
                      setState(null);
                      setValues({});
                      setPollError(null);
                    })
                  }
                >
                  Cancel sign-in
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {(action.error || pollError) && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {action.error || pollError}
          {pollError && (
            <button className="ms-2 underline" onClick={() => setPollError(null)}>
              Retry
            </button>
          )}
        </p>
      )}
    </section>
  );
}
