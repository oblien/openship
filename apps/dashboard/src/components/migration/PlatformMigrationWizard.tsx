"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import type { CredentialProvider } from "@repo/core";
import type {
  PlatformDiscovery,
  PlatformProject,
  PlatformMigrationPlan,
  MigrationRun,
  TransferProgress,
} from "@repo/contracts";
import { credentialsApi, type Credential } from "@/lib/api/credentials";
import { platformMigrationApi } from "@/lib/api/platform-migration";
import { dockerMigrationApi } from "@/lib/api/server-migration";
import { getApiErrorMessage } from "@/lib/api/client";
import { AppLogo } from "@/components/AppLogo";
import { CredentialForm } from "@/components/credentials/CredentialForm";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { PlatformImportServices } from "./PlatformImportServices";
import { PlatformImportReview } from "./PlatformImportReview";
import { PlatformImportProgress, importFinished } from "./PlatformImportProgress";
import { PLATFORM_IMPORT_HELP, type ImportChoice, type ImportStep } from "./platform-import-model";

const steps = [
  { id: "connect", label: "Connect" },
  { id: "services", label: "Select services" },
  { id: "review", label: "Review & import" },
] as const;
type ReadState = "loading" | "ready" | "error" | "idle";

/** All entry points use the same connection form, provider APIs, destination
 * picker and durable migration run. Steps only control the presentation. */
export function PlatformMigrationWizard({
  provider,
  onBack,
  initialRunId,
  initialTargetId,
}: {
  provider: "railway" | "vercel";
  onBack: () => void;
  initialRunId?: string;
  initialTargetId?: string;
}) {
  const router = useRouter();
  const help = PLATFORM_IMPORT_HELP[provider];
  const [step, setStep] = useState<ImportStep>("connect");
  const [catalog, setCatalog] = useState<CredentialProvider>();
  const [connections, setConnections] = useState<Credential[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [form, setForm] = useState<"add" | Credential | null>(null);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [connectionActions, setConnectionActions] = useState<HTMLDivElement | null>(null);
  const [connectionState, setConnectionState] = useState<ReadState>("loading");
  const [connectionRetry, setConnectionRetry] = useState(0);
  const [accessState, setAccessState] = useState<ReadState>("idle");
  const [accessError, setAccessError] = useState("");
  const [accessRetry, setAccessRetry] = useState(0);
  const [projects, setProjects] = useState<PlatformProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [discovery, setDiscovery] = useState<PlatformDiscovery>();
  const [projectName, setProjectName] = useState("");
  const [choices, setChoices] = useState<Record<string, ImportChoice>>({});
  const [targetId, setTargetId] = useState(initialTargetId ?? "");
  const [targetName, setTargetName] = useState("");
  const [targetReady, setTargetReady] = useState(false);
  const [plan, setPlan] = useState<PlatformMigrationPlan>();
  const [writesPaused, setWritesPaused] = useState(false);
  const [workersPaused, setWorkersPaused] = useState(false);
  const [runId, setRunId] = useState(initialRunId);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [run, setRun] = useState<MigrationRun>();
  const [confirmation, setConfirmation] = useState("");
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [statusRetry, setStatusRetry] = useState(0);
  const [statusError, setStatusError] = useState("");
  const [busyLabel, setBusyLabel] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  const working = useRef(false);
  const active = connections.find((connection) => connection.id === connectionId);
  const busy = !!busyLabel || credentialBusy;
  const reading = connectionState === "loading" || accessState === "loading";
  const stepIndex = steps.findIndex((s) => s.id === step);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function action(label: string, work: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusyLabel(label);
    setError("");
    try {
      await work();
    } catch (cause) {
      if (alive.current)
        setError(
          getApiErrorMessage(
            cause,
            "This step could not complete. Try again; your source is unchanged.",
          ),
        );
    } finally {
      working.current = false;
      if (alive.current) setBusyLabel("");
    }
  }
  const invalidateReview = () => {
    setPlan(undefined);
    setWritesPaused(false);
    setWorkersPaused(false);
    setError("");
  };
  const changeSource = () => {
    setDiscovery(undefined);
    setChoices({});
    invalidateReview();
  };

  useEffect(() => {
    if (initialRunId) return;
    let cancelled = false;
    setConnectionState("loading");
    setError("");
    void Promise.all([credentialsApi.providers(), credentialsApi.list()])
      .then(([providers, result]) => {
        if (cancelled) return;
        setCatalog(providers.data.find((p) => p.id === provider));
        const rows = result.data.filter((row) => row.provider === provider);
        setConnections(rows);
        setConnectionId((current) =>
          rows.some((row) => row.id === current) ? current : rows.length === 1 ? rows[0].id : "",
        );
        setForm(rows.length ? null : "add");
        setConnectionState("ready");
      })
      .catch((cause) => {
        if (!cancelled) {
          setConnectionState("error");
          setError(getApiErrorMessage(cause, "Connections could not be loaded."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [provider, initialRunId, connectionRetry]);

  useEffect(() => {
    if (!connectionId || initialRunId) return;
    let cancelled = false;
    setAccessState("loading");
    setAccessError("");
    void platformMigrationApi
      .projects(connectionId)
      .then((result) => {
        if (cancelled) return;
        setProjects(result.projects);
        setProjectId((current) =>
          result.projects.some((project) => project.id === current)
            ? current
            : result.projects.length === 1
              ? result.projects[0].id
              : "",
        );
        setAccessState("ready");
      })
      .catch((cause) => {
        if (!cancelled) {
          setAccessState("error");
          setAccessError(
            getApiErrorMessage(
              cause,
              "Project access could not be checked. Check the connection’s account and permissions.",
            ),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, accessRetry, initialRunId]);

  useEffect(() => {
    const environments = projects.find((project) => project.id === projectId)?.environments ?? [];
    setEnvironmentId((current) =>
      environments.some((environment) => environment.id === current)
        ? current
        : (environments[0]?.id ?? ""),
    );
  }, [projects, projectId]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await dockerMigrationApi.getMigration(runId);
        if (cancelled) return;
        setRun(result.run);
        setProgress(result.progress ?? null);
        setStatusError("");
        if (result.run.confirmationToken) setConfirmation(result.run.confirmationToken);
        if (!importFinished(result.run.status)) timer = setTimeout(poll, 2500);
      } catch (cause) {
        if (!cancelled) {
          setStatusError(
            getApiErrorMessage(
              cause,
              "Status is unavailable. The import may still be running. Reconnecting…",
            ),
          );
          timer = setTimeout(poll, 5000);
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId, statusRetry]);

  const testConnection = () =>
    action("Testing connection…", async () => {
      setAccessState("loading");
      setAccessError("");
      try {
        const { data } = await credentialsApi.verify(connectionId);
        if (!alive.current) return;
        setConnections((current) => current.map((row) => (row.id === data.id ? data : row)));
        if (data.status !== "active")
          throw new Error(
            data.lastError ||
              "The provider did not accept this connection. Update its token and try again.",
          );
        setAccessRetry((value) => value + 1);
      } catch (cause) {
        if (alive.current) {
          setAccessState("error");
          setAccessError(
            getApiErrorMessage(
              cause,
              "Connection test failed. Update its token or permissions and try again.",
            ),
          );
        }
      }
    });
  const discover = () =>
    action("Discovering services…", async () => {
      if (discovery) {
        setStep("services");
        return;
      }
      const data = await platformMigrationApi.discover({ connectionId, projectId, environmentId });
      if (!alive.current) return;
      setDiscovery(data);
      setProjectName(data.projectName);
      setChoices(
        Object.fromEntries(
          data.services.map((service) => [
            service.id,
            {
              id: service.id,
              name: service.name,
              selected: true,
              data: service.external
                ? "external"
                : service.kind === "database" || service.volumes.length
                  ? "copy"
                  : "empty",
              env: {},
            },
          ]),
        ),
      );
      invalidateReview();
      setStep("services");
    });
  const review = () =>
    action("Checking import…", async () => {
      const result = await platformMigrationApi.review({
        draftId: discovery!.draftId,
        targetServerId: targetId,
        projectName,
        services: Object.values(choices)
          .filter((choice) => choice.selected)
          .map(({ selected: _selected, ...choice }) => choice),
      });
      if (!alive.current) return;
      const added = result.services.filter(
        (service) => !discovery!.services.some((existing) => existing.id === service.id),
      );
      if (added.length) {
        setDiscovery(
          (current) => current && { ...current, services: [...current.services, ...added] },
        );
        setChoices((current) => ({
          ...current,
          ...Object.fromEntries(
            added.map((service) => [
              service.id,
              {
                id: service.id,
                name: service.name,
                data: "external" as const,
                selected: true,
                env: {},
              },
            ]),
          ),
        }));
      }
      setPlan(result);
      setWritesPaused(false);
      setWorkersPaused(false);
      if (result.ready) setStep("review");
    });
  const start = () =>
    action("Starting import…", async () => {
      const result = await platformMigrationApi.start({
        planId: plan!.planId,
        writesPaused,
        workersPaused,
      });
      if (!alive.current) return;
      setRunId(result.migrationId);
      setConfirmation(result.confirmationToken);
      setChoices({});
      setDiscovery(undefined);
      setPlan(undefined);
      router.push(`/migrations/${encodeURIComponent(result.migrationId)}`);
    });
  const goTo = (next: ImportStep) => {
    if (!busy) {
      setStep(next);
      setError("");
    }
  };

  const header = (
    <div className={runId ? "flex flex-wrap items-center justify-between gap-4" : "space-y-3"}>
      <div className="flex min-w-0 items-center gap-3">
        <AppLogo slug={provider} className={runId ? "size-8 shrink-0" : "size-10 shrink-0"} />
        <div className="min-w-0">
          <h2 className={runId ? "truncate text-xl font-semibold" : "text-lg font-semibold"}>
            {run ? run.projectName : `Import from ${help.name}`}
          </h2>
          {runId && (
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Track your import and finish the move.
            </p>
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className={runId ? undefined : "-ms-2 text-xs text-muted-foreground"}
        disabled={busy}
        onClick={onBack}
      >
        <Icon name="arrow-left" className="size-4" />
        {runId ? "Back" : "Change source"}
      </Button>
    </div>
  );

  return (
    <div className="w-full space-y-6 py-2">
      {runId && header}
      {!runId && (
        <nav aria-label="Import steps" className="border-b border-border/50 pb-4">
          <ol className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:gap-x-8">
            {steps.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={
                    busy ||
                    (item.id === "services" && !discovery) ||
                    (item.id === "review" && !plan?.ready)
                  }
                  aria-current={item.id === step ? "step" : undefined}
                  onClick={() => goTo(item.id)}
                  className={`inline-flex items-center gap-2 rounded-lg py-1 text-xs focus-visible:outline-2 focus-visible:outline-ring sm:text-sm ${item.id === step ? "font-medium text-foreground" : "text-muted-foreground"}`}
                >
                  <span
                    className={`flex size-6 items-center justify-center rounded-full text-xs ${item.id === step ? "bg-foreground text-background" : "bg-muted/60"}`}
                  >
                    {index < stepIndex ? <Icon name="check" className="size-3.5" /> : index + 1}
                  </span>
                  {item.label}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
      {(error || statusError) && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-danger-bg p-4 text-sm text-danger"
        >
          <span>{error || statusError}</span>
          {connectionState === "error" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConnectionRetry((value) => value + 1)}
            >
              Retry
            </Button>
          )}
          {statusError && (
            <Button variant="ghost" size="sm" onClick={() => setStatusRetry((value) => value + 1)}>
              Retry status
            </Button>
          )}
        </div>
      )}
      {runId ? (
        <PlatformImportProgress
          run={run}
          progress={progress}
          busy={busy}
          stopping={stoppingRunId === runId}
          canConfirm={!!confirmation}
          onConfirm={() =>
            void action("Finishing import…", async () => {
              await dockerMigrationApi.confirmCutover(runId, confirmation, false, false);
              if (alive.current) setStatusRetry((value) => value + 1);
            })
          }
          onStop={() =>
            void action("Stopping import…", async () => {
              setStoppingRunId(runId);
              try {
                await dockerMigrationApi.cancel(runId);
              } catch (error) {
                if (alive.current) setStoppingRunId(null);
                throw error;
              }
              if (alive.current) setStatusRetry((value) => value + 1);
            })
          }
          onRetryStatus={() => setStatusRetry((value) => value + 1)}
        />
      ) : step === "services" && discovery ? (
        <PlatformImportServices
          sidebarHeader={header}
          discovery={discovery}
          choices={choices}
          plan={plan}
          busy={busy}
          targetId={targetId}
          targetReady={targetReady}
          projectName={projectName}
          onProjectName={(name) => {
            setProjectName(name);
            invalidateReview();
          }}
          onChoose={(id, patch) => {
            setChoices((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
            invalidateReview();
          }}
          onTarget={(id, name) => {
            setTargetName(name);
            if (id !== targetId) {
              setTargetId(id);
              invalidateReview();
            }
          }}
          onTargetReady={setTargetReady}
          onReview={() => void review()}
        />
      ) : step === "review" && plan ? (
        <PlatformImportReview
          sidebarHeader={header}
          plan={plan}
          choices={choices}
          targetName={targetName}
          busy={busy}
          writesPaused={writesPaused}
          workersPaused={workersPaused}
          onWritesPaused={setWritesPaused}
          onWorkersPaused={setWorkersPaused}
          onEdit={() => goTo("services")}
          onStart={() => void start()}
        />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="space-y-6 rounded-2xl bg-card p-5 sm:p-6">
            <div>
              <h3 className="font-semibold">
                {form ? `Connect ${help.name}` : "Select your source project"}
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {form
                  ? "Save a connection to discover the projects you can access."
                  : "Choose a saved connection, then the project and environment to import."}
              </p>
            </div>
            {connectionState === "loading" ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Icon name="spinner" className="size-4 animate-spin" />
                Loading connections…
              </p>
            ) : form && catalog ? (
              <CredentialForm
                key={typeof form === "string" ? "new" : form.id}
                provider={catalog}
                existing={typeof form === "string" ? undefined : form}
                initialName={`${help.name} connection`}
                submitLabel={typeof form === "string" ? "Test & connect" : "Test & save changes"}
                onBusyChange={setCredentialBusy}
                actionsContainer={connectionActions}
                onCancel={() => setForm(null)}
                onSaved={(row) => {
                  setConnections((current) => [
                    ...current.filter((connection) => connection.id !== row.id),
                    row,
                  ]);
                  if (row.id === connectionId) setAccessRetry((value) => value + 1);
                  else {
                    setConnectionId(row.id);
                    setProjects([]);
                    setProjectId("");
                    setEnvironmentId("");
                  }
                  changeSource();
                  setForm(null);
                }}
              />
            ) : (
              <>
                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <label className="text-xs font-medium" htmlFor="import-connection">
                      Connection
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || !catalog}
                      onClick={() => setForm("add")}
                    >
                      <Icon name="plus" className="size-3.5" />
                      Add connection
                    </Button>
                  </div>
                  <CustomSelect
                    id="import-connection"
                    variant="filled"
                    triggerClassName="bg-muted/60 hover:bg-muted"
                    value={connectionId}
                    disabled={busy}
                    placeholder="Choose a connection"
                    options={connections.map((row) => ({
                      value: row.id,
                      label: row.name,
                      description:
                        row.status === "active"
                          ? row.publicFields?.authorization === "oauth"
                            ? "Connected account"
                            : "API token"
                          : "Needs attention",
                      icon: <AppLogo slug={provider} className="size-4" />,
                    }))}
                    onChange={(value) => {
                      setConnectionId(value);
                      setProjects([]);
                      setProjectId("");
                      setEnvironmentId("");
                      changeSource();
                    }}
                  />
                </div>
                {connectionId && (
                  <div
                    className={`rounded-xl p-4 ${accessState === "error" ? "bg-warning-bg" : "bg-card"}`}
                  >
                    <div className="flex items-start gap-2.5">
                      <Icon
                        name={
                          accessState === "loading"
                            ? "spinner"
                            : accessState === "ready"
                              ? "check-circle"
                              : "warning"
                        }
                        className={`mt-0.5 size-4 shrink-0 ${accessState === "loading" ? "animate-spin text-muted-foreground" : accessState === "ready" ? "text-success" : "text-warning"}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p role="status" className="text-sm font-medium">
                          {accessState === "loading"
                            ? busyLabel || "Checking project access…"
                            : accessState === "ready"
                              ? "Project access verified"
                              : "Connection needs attention"}
                        </p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          {accessState === "error"
                            ? accessError
                            : accessState === "ready"
                              ? `${projects.length} ${projects.length === 1 ? "project" : "projects"} available to this connection.`
                              : "Reading the provider’s current project list."}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 ps-6">
                      {active && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy || reading}
                          onClick={() => {
                            if (active.publicFields?.authorization === "oauth") setForm("add");
                            else setForm(active);
                          }}
                        >
                          {active.publicFields?.authorization === "oauth"
                            ? "Connect another account"
                            : "Edit connection"}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
                {accessState === "ready" && projects.length > 0 && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-2 block text-xs font-medium" htmlFor="import-project">
                        Project
                      </label>
                      <CustomSelect
                        id="import-project"
                        variant="filled"
                        triggerClassName="bg-muted/60 hover:bg-muted"
                        value={projectId}
                        disabled={busy}
                        placeholder="Choose a project"
                        searchable
                        options={projects.map((project) => ({
                          value: project.id,
                          label: project.name,
                          icon: <Icon name="project" className="size-4" />,
                        }))}
                        onChange={(value) => {
                          setProjectId(value);
                          setEnvironmentId("");
                          changeSource();
                        }}
                      />
                    </div>
                    <div>
                      <label
                        className="mb-2 block text-xs font-medium"
                        htmlFor="import-environment"
                      >
                        Environment
                      </label>
                      <CustomSelect
                        id="import-environment"
                        variant="filled"
                        triggerClassName="bg-muted/60 hover:bg-muted"
                        value={environmentId}
                        disabled={busy || !projectId}
                        placeholder="Choose an environment"
                        options={(
                          projects.find((project) => project.id === projectId)?.environments ?? []
                        ).map((environment) => ({
                          value: environment.id,
                          label: environment.name,
                        }))}
                        onChange={(value) => {
                          setEnvironmentId(value);
                          changeSource();
                        }}
                      />
                    </div>
                  </div>
                )}
                {accessState === "ready" && !projects.length && (
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    No projects were returned. Check the token’s workspace or team scope, or connect
                    another account.
                  </p>
                )}
              </>
            )}
            {connectionState === "ready" && !catalog && (
              <p role="alert" className="text-sm text-warning">
                This instance does not offer {help.name} connections.
              </p>
            )}
          </section>
          <aside className="space-y-5 rounded-2xl bg-card p-5 lg:sticky lg:top-6">
            {header}
            {connectionState === "ready" &&
              catalog &&
              (form ? (
                <div ref={setConnectionActions} />
              ) : (
                <div className="space-y-2">
                  <Button
                    className="w-full"
                    disabled={
                      busy || reading || accessState !== "ready" || !projectId || !environmentId
                    }
                    onClick={() => void discover()}
                  >
                    {busy && !reading ? (
                      <Icon name="spinner" className="size-4 animate-spin" />
                    ) : (
                      <Icon name="arrow-right" className="size-4" />
                    )}
                    Choose services
                  </Button>
                  {connectionId && (
                    <Button
                      variant="secondary"
                      className="w-full"
                      disabled={busy || reading}
                      onClick={() => void testConnection()}
                    >
                      <Icon
                        name={busy && reading ? "spinner" : "refresh"}
                        className={busy && reading ? "size-4 animate-spin" : "size-4"}
                      />
                      {busy && reading ? busyLabel : "Test connection"}
                    </Button>
                  )}
                </div>
              ))}
            <Button asChild variant="secondary" size="sm" className="w-full justify-between">
              <a href={help.tokenUrl} target="_blank" rel="noopener noreferrer">
                Create an API token
                <Icon name="external-link" className="size-3.5" />
              </a>
            </Button>
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                Import details
                <Icon
                  name="chevron-down"
                  className="size-3.5 transition-transform group-open:rotate-180"
                />
              </summary>
              <div className="mt-4 space-y-4">
                <div>
                  <h3 className="text-xs font-medium">Connection access</h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    {help.access}
                  </p>
                </div>
                <div>
                  <h3 className="text-xs font-medium">Moving data</h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    {help.data}
                  </p>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
                  <Link
                    href="/settings?tab=connections"
                    target="_blank"
                    className="inline-flex items-center gap-1.5 hover:text-foreground"
                  >
                    Manage connections
                    <Icon name="external-link" className="size-3.5" />
                  </Link>
                  <a
                    href={help.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 hover:text-foreground"
                  >
                    Provider guide
                    <Icon name="external-link" className="size-3.5" />
                  </a>
                </div>
              </div>
            </details>
          </aside>
        </div>
      )}
    </div>
  );
}
