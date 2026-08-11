"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Server,
  ArrowLeft,
  Loader2,
  KeyRound,
  Network,
  Info,
} from "lucide-react";
import { getApiErrorMessage, systemApi } from "@/lib/api";
import type { ComponentStatus, ServerInfo } from "@/lib/api/system";
import { PageContainer } from "@/components/ui/PageContainer";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import { useSetupStream } from "@/hooks/useSetupStream";
import { ServerForm } from "../_components/server-form";
import { AutoSetupFlow } from "./_components/auto-setup-flow";
import { CheckingState } from "./_components/checking-state";
import { ChooseMode } from "./_components/choose-mode";
import { ErrorBanner } from "./_components/error-banner";
import { InstallingPanel } from "./_components/installing-panel";
import { ResultsPanel } from "./_components/results-panel";
import { SetupHeader } from "./_components/setup-header";
import {
  type ComponentState,
  type SetupMode,
  type Step,
} from "./_components/types";

function buildComponentStates(
  statuses: ComponentStatus[] = [],
  previous: ComponentState[] = [],
): ComponentState[] {
  const nextNames = [
    ...new Set([
      ...statuses.map((status) => status.name),
      ...previous.map((component) => component.name),
    ]),
  ];

  return nextNames.map((name) => {
    const status = statuses.find((entry) => entry.name === name) ?? null;
    const existing = previous.find((component) => component.name === name);
    const installState = status?.healthy
      ? "installed"
      : existing?.installState === "installed"
        ? "installed"
        : existing?.installState ?? "idle";

    return {
      name,
      label: status?.label ?? existing?.label ?? name,
      description:
        status?.description ?? existing?.description ?? `${name} component`,
      status,
      installState,
      installError: existing?.installError,
    };
  });
}

function getMissingComponentNames(components: ComponentState[]): string[] {
  return components
    .filter((component) => !component.status?.healthy && !component.status?.optional && component.status?.installable !== false)
    .map((component) => component.name);
}

export default function AddServerPage() {
  const router = useRouter();
  const { showToast } = useToast();
  const { t } = useI18n();

  const [loaded, setLoaded] = useState(false);

  const [hasExistingServer, setHasExistingServer] = useState(false);
  const [existingServerId, setExistingServerId] = useState<string | null>(null);
  const [initialServer, setInitialServer] = useState<ServerInfo | null>(null);

  // null = credentials form is rendered. Becomes "choose"/"checking"/
  // "installing"/"results" once the server is saved and the component-setup
  // flow starts. Servers are just servers - no upfront workload picker.
  const [step, setStep] = useState<Step | null>(null);
  const [mode, setMode] = useState<SetupMode>(null);
  const [components, setComponents] = useState<ComponentState[]>(() =>
    buildComponentStates(),
  );
  const [overallReady, setOverallReady] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  // SSE streaming for installs
  const setupStream = useSetupStream({
    onComplete: (event) => {
      // After streaming finishes, run a final health check
      void (async () => {
        try {
          const currentServerId = existingServerId ?? initialServer?.id ?? null;
          if (!currentServerId) return;
          const result = await systemApi.checkServer(currentServerId);
          setComponents((current) => buildComponentStates(result.components, current));
          setOverallReady(result.ready);
        } catch {
          // Keep whatever we have from the stream
        }
        if (event.status === "completed") {
          showToast(t.servers.setup.toastSetupCompleted, "success", t.servers.toastTitles.serverSetup);
        } else {
          showToast(t.servers.setup.toastSomeComponentsFailed, "error", t.servers.toastTitles.serverSetup);
        }
      })();
    },
  });

  const activeServerId = existingServerId ?? initialServer?.id ?? null;

  const serverHostLabel =
    initialServer?.sshHost || initialServer?.name || t.servers.setup.yourServer;

  useEffect(() => {
    (async () => {
      try {
        // /servers/new is ADD-ONLY. Editing an existing server happens SOLELY
        // via an explicit `?edit=<id>`. We must NEVER auto-load an existing
        // server here — doing so put the form in edit mode and Save would PATCH
        // (overwrite) that server instead of creating a new one. The only other
        // reason to pre-load a server is reload-recovery of an install that's
        // already running, which we key off the ACTIVE session — not "the only
        // server that happens to exist".
        const editId =
          typeof window !== "undefined"
            ? new URLSearchParams(window.location.search).get("edit")
            : null;

        let session: Awaited<ReturnType<typeof systemApi.getInstallSession>> | null = null;
        try {
          session = await systemApi.getInstallSession();
        } catch {
          /* no active session */
        }

        let existing: ServerInfo | null = null;
        if (editId) {
          existing = await systemApi.getServerById(editId).catch(() => null);
        } else if (session?.active && session.status === "running" && session.serverId) {
          existing = await systemApi.getServerById(session.serverId).catch(() => null);
        }

        if (existing) {
          setHasExistingServer(true);
          setExistingServerId(existing.id);
          setInitialServer(existing);

          // Resume the in-flight install stream after a reload.
          if (
            session?.active &&
            session.status === "running" &&
            session.sessionId &&
            session.serverId === existing.id
          ) {
            setStep("installing");
            void setupStream.attachToSession(session.sessionId);
          }
        }
      } catch {
        /* fresh form */
      } finally {
        setLoaded(true);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function resetSetup() {
    setStep(null);
    setMode(null);
    setSetupError(null);
    setOverallReady(false);
    setComponents(buildComponentStates());
  }

  function handleSaved({ server, isEditing }: { server: ServerInfo; isEditing: boolean }) {
    if (isEditing) {
      router.push("/servers");
      return;
    }
    // New server created - move into the component-setup flow.
    setHasExistingServer(true);
    setExistingServerId(server.id);
    setInitialServer(server);
    resetSetup();
    setStep("choose");
  }

  async function runSetupChecks(selectedMode: SetupMode) {
    if (!activeServerId) {
      showToast(t.servers.setup.toastSaveBeforeSetup, "error", t.servers.toastTitles.serverSetup);
      return;
    }

    setMode(selectedMode);
    setSetupError(null);
    setStep("checking");

    try {
      const result = await systemApi.checkServer(activeServerId);
      let newComponents: ComponentState[] = [];
      setComponents((current) => {
        newComponents = buildComponentStates(result.components, current);
        return newComponents;
      });
      setOverallReady(result.ready);

      // Auto mode: skip results screen and install immediately
      if (selectedMode === "auto" && !result.ready) {
        const missing = getMissingComponentNames(newComponents);
        if (missing.length > 0) {
          void installComponents(missing);
          return;
        }
      }

      setStep("results");
    } catch (err) {
      const message = getApiErrorMessage(err, t.servers.setup.toastHealthCheckFailed);
      setOverallReady(false);
      setSetupError(message);
      setStep("choose");
      showToast(message, "error", t.servers.toastTitles.serverSetup);
    }
  }

  async function installComponents(targetNames?: string[]) {
    if (!activeServerId) {
      showToast(t.servers.setup.toastSaveBeforeInstall, "error", t.servers.toastTitles.serverSetup);
      return;
    }

    const names = (targetNames?.length ? targetNames : getMissingComponentNames(components))
      .filter((name, index, list) => list.indexOf(name) === index);

    if (names.length === 0) {
      setOverallReady(true);
      showToast(t.servers.setup.toastAlreadyReady, "success", t.servers.toastTitles.serverSetup);
      return;
    }

    setSetupError(null);
    setStep("installing");

    try {
      await setupStream.startInstall(activeServerId, names);
    } catch (err) {
      const message = getApiErrorMessage(err, t.servers.setup.toastFailedStartInstall);
      setSetupError(message);
      showToast(message, "error", t.servers.toastTitles.serverSetup);
    }
  }

  function handleSetupBack() {
    if (step === "installing" && !setupStream.isDone) return;
    if (step === "installing" && setupStream.isDone) {
      router.push(activeServerId ? `/servers/${activeServerId}` : "/servers");
      return;
    }
    if (step === "choose") {
      resetSetup();
      return;
    }
    setStep("choose");
  }

  if (!loaded) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (step) {
    return (
      <PageContainer className="max-w-[1180px]">
          <SetupHeader
            step={step}
            serverHost={serverHostLabel}
            overallReady={overallReady}
            components={components}
            onBack={handleSetupBack}
          />

          {setupError && <ErrorBanner message={setupError} />}

          {step === "choose" && (
            <ChooseMode
              onSelect={(selectedMode) => {
                void runSetupChecks(selectedMode);
              }}
              onSkip={() => router.push(activeServerId ? `/servers/${activeServerId}` : "/servers")}
            />
          )}

          {mode === "auto" && step !== "choose" ? (
            <AutoSetupFlow
              step={step}
              components={components}
              overallReady={overallReady}
              serverHost={serverHostLabel}
              streamComponents={setupStream.components}
              streamLogs={setupStream.logs}
              streamDone={setupStream.isDone}
              streamFinalStatus={setupStream.finalStatus}
              onDone={() => router.push(activeServerId ? `/servers/${activeServerId}` : "/servers")}
              onRetry={() => {
                const failedNames = setupStream.components
                  .filter((c) => c.status === "failed")
                  .map((c) => c.name);
                if (failedNames.length > 0) {
                  void installComponents(failedNames);
                }
              }}
            />
          ) : (
            <>
              {step === "checking" && <CheckingState />}

              {step === "results" && (
                <ResultsPanel
                  components={components}
                  serverHost={serverHostLabel}
                  overallReady={overallReady}
                  mode={mode ?? "manual"}
                  onAutoInstall={() => {
                    void installComponents();
                  }}
                  onManualContinue={() => {
                    void installComponents();
                  }}
                  onRecheck={() => {
                    void runSetupChecks(mode ?? "manual");
                  }}
                  onDone={() => router.push(activeServerId ? `/servers/${activeServerId}` : "/servers")}
                />
              )}

              {step === "installing" && (
                <InstallingPanel
                  components={setupStream.components}
                  logs={setupStream.logs}
                  serverHost={serverHostLabel}
                  isDone={setupStream.isDone}
                  finalStatus={setupStream.finalStatus}
                  onDone={() => router.push(activeServerId ? `/servers/${activeServerId}` : "/servers")}
                  onRetry={() => {
                    const failedNames = setupStream.components
                      .filter((c) => c.status === "failed")
                      .map((c) => c.name);
                    if (failedNames.length > 0) {
                      void installComponents(failedNames);
                    }
                  }}
                />
              )}
            </>
          )}
      </PageContainer>
    );
  }

  return (
    <PageContainer>
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => router.push("/servers")}
            className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center transition-colors"
          >
            <ArrowLeft className="size-4 text-muted-foreground rtl:rotate-180" />
          </button>
          <div>
            <h1
              className="text-2xl font-medium text-foreground/80"
              style={{ letterSpacing: "-0.2px" }}
            >
              {hasExistingServer ? t.servers.setup.editServer : t.servers.setup.addServer}
            </h1>
            <p className="text-sm text-muted-foreground/70 mt-0.5">
              {t.servers.setup.enterDetails}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
          <div className="space-y-6 min-w-0">
            <ServerForm
              key={initialServer?.id ?? "new"}
              server={initialServer}
              onSaved={handleSaved}
            />
          </div>

          <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <div className="bg-card rounded-2xl border border-border/50">
              <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
                <div className="w-9 h-9 bg-warning-bg rounded-xl flex items-center justify-center">
                  <Info className="size-[18px] text-warning" />
                </div>
                <div>
                  <h2 className="font-semibold text-foreground text-[15px]">
                    {t.servers.setup.gettingStarted}
                  </h2>
                  <p className="text-xs text-muted-foreground">{t.servers.setup.whatYouNeed}</p>
                </div>
              </div>
              <div className="p-5">
                <ul className="space-y-3 text-sm text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <Network className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                    <span>
                      {t.servers.setup.needServer}
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <KeyRound className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                    <span>{t.servers.setup.needAuth}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Server className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                    <span>
                      {t.servers.setup.needChecks}
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
    </PageContainer>
  );
}
