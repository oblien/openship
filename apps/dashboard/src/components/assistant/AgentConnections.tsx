"use client";
import { useEffect, useState } from "react";
import {
  ASSISTANT_PROVIDER_LABELS,
  assistantFieldInput,
  type AssistantProviderInfo,
  type AssistantProvider,
  type AuthState,
} from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { assistantApi } from "@/lib/api/assistant";
import { getApiErrorMessage } from "@/lib/api/client";
import { useScopedMutation } from "@/hooks/use-scoped-resource";
import { AssistantFields } from "./AssistantFields";
import { CustomApiConnection } from "./CustomApiConnection";

export function AgentConnections({
  agents,
  hostName,
  selected,
  onSelect,
  onRefresh,
  loading,
  error,
}: {
  agents: AssistantProviderInfo[];
  hostName?: string;
  selected: AssistantProvider;
  onSelect(provider: AssistantProvider): void;
  onRefresh(): void;
  loading: boolean;
  error: string | null;
}) {
  const [custom, setCustom] = useState(false);
  return (
    <div className="p-5 sm:p-8">
      <div className="mb-7 pe-10">
        <h2 className="text-xl font-medium text-foreground">AI connections</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Connect the account you already use. Choose your agent in any new chat.
        </p>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      {loading && !agents.length && (
        <p role="status" className="text-sm text-muted-foreground">
          Checking your installed agents…
        </p>
      )}
      <div className="grid items-start gap-6 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-8">
        <div>
          <div role="tablist" aria-label="Agent connections" className="flex gap-2 sm:flex-col">
            {agents.map((agent) => (
              <button
                key={agent.id}
                id={`agent-tab-${agent.id}`}
                type="button"
                role="tab"
                aria-selected={!custom && agent.id === selected}
                aria-controls={`agent-panel-${agent.id}`}
                tabIndex={!custom && agent.id === selected ? 0 : -1}
                onClick={() => {
                  setCustom(false);
                  onSelect(agent.id);
                }}
                onKeyDown={(event) => {
                  const direction =
                    event.key === "ArrowRight" || event.key === "ArrowDown"
                      ? 1
                      : event.key === "ArrowLeft" || event.key === "ArrowUp"
                        ? -1
                        : 0;
                  if (!direction) return;
                  event.preventDefault();
                  const next =
                    agents[(agents.indexOf(agent) + direction + agents.length) % agents.length];
                  setCustom(false);
                  onSelect(next.id);
                  document.getElementById(`agent-tab-${next.id}`)?.focus();
                }}
                className={`flex flex-1 items-center gap-3 rounded-xl p-3 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:p-4 ${!custom && agent.id === selected ? "bg-card text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
              >
                <Icon name={agent.id} className="size-5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{ASSISTANT_PROVIDER_LABELS[agent.id]}</span>
                  <span className="mt-1 hidden text-xs text-muted-foreground sm:block">
                    {agent.authStatus.configured ? "Connected" : "Not connected"}
                  </span>
                </span>
                {agent.authStatus.configured && (
                  <Icon name="check" className="size-3.5 shrink-0 text-success" />
                )}
              </button>
            ))}
          </div>
          <Button
            variant={custom ? "secondary" : "ghost"}
            className="mt-2 w-full justify-start"
            aria-pressed={custom}
            onClick={() => setCustom(true)}
          >
            <Icon name="code" /> Custom API
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="mt-4"
            disabled={loading}
            onClick={onRefresh}
            aria-label="Check agent connections"
          >
            <Icon name="refresh" className={loading ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>
        <div className="min-w-0">
          {agents.map((agent) => (
            <div
              key={agent.id}
              id={`agent-panel-${agent.id}`}
              role="tabpanel"
              aria-labelledby={`agent-tab-${agent.id}`}
              hidden={custom || agent.id !== selected}
            >
              <AgentConnection info={agent} refresh={onRefresh} />
            </div>
          ))}
          {custom && (
            <div className="rounded-2xl bg-card p-5">
              <CustomApiConnection
                available={!!agents.find((a) => a.id === "codex")?.customApiAvailable}
                onSaved={() => {
                  onRefresh();
                }}
              />
              {agents
                .find((a) => a.id === "codex")
                ?.customProviders?.map((p) => (
                  <div key={p.id} className="mt-4 rounded-xl bg-background p-3 text-sm">
                    <p>{p.name}</p>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      {p.models.join(", ")}
                    </p>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
      <div className="mt-7 flex items-center gap-2 text-xs leading-5 text-muted-foreground">
        <Icon name="lock" className="size-3.5 shrink-0" />
        <span>
          Your connection stays on {hostName || "the assistant host"}. OpenShip uses the access you
          approved.
        </span>
      </div>
    </div>
  );
}

function AgentConnection({ info, refresh }: { info: AssistantProviderInfo; refresh(): void }) {
  const [method, setMethod] = useState("");
  const [state, setState] = useState<AuthState | null>(null),
    [values, setValues] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [pollError, setPollError] = useState<string | null>(null);
  const action = useScopedMutation();
  const selectedMethod = info.authMethods.find((m) => m.id === method);
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
    <section className="min-w-0 rounded-2xl bg-card p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-xl bg-muted/60">
          <Icon name={info.id} className="size-6" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-medium">{ASSISTANT_PROVIDER_LABELS[info.id]}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {info.authStatus.configured
              ? "Connected"
              : info.available
                ? "Ready to connect"
                : "Not available"}
            {info.installedVersion ? ` · ${info.installedVersion}` : ""}
          </p>
        </div>
        {info.authStatus.configured && <Icon name="check" className="size-4 text-success" />}
      </div>
      {info.issue && <p className="mt-4 text-sm leading-6 text-muted-foreground">{info.issue}</p>}
      {info.available && (
        <div className="mt-5 space-y-5">
          {info.authStatus.configured ? (
            <>
              <p className="text-sm leading-6 text-muted-foreground">
                {info.authStatus.detail ||
                  "Your saved connection is ready. Your agent can only use the tools and resources you authorize."}
              </p>
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
              <CustomSelect
                aria-label={`Sign-in method for ${ASSISTANT_PROVIDER_LABELS[info.id]}`}
                value={method}
                options={info.authMethods.map((m) => ({
                  value: m.id,
                  label: m.label,
                  description: m.help,
                }))}
                onChange={(value) => {
                  setMethod(value);
                  setState(null);
                  setPollError(null);
                  setValues({});
                }}
                placeholder="Choose a sign-in method"
                variant="filled"
                triggerClassName="bg-muted/60 hover:bg-muted"
                disabled={action.busy || state?.status === "pending"}
              />
              {!state && method && (
                <>
                  <p className="text-xs leading-5 text-muted-foreground">{selectedMethod?.help}</p>
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
          {(action.error || pollError) && (
            <p role="alert" className="text-sm text-danger">
              {action.error || pollError}
              {pollError && (
                <button className="ms-2 underline" onClick={() => setPollError(null)}>
                  Retry
                </button>
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
