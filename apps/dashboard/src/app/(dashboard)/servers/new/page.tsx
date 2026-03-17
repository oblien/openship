"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Server,
  ArrowLeft,
  Loader2,
  Check,
  KeyRound,
  Lock,
  ChevronDown,
  Network,
  Info,
} from "lucide-react";
import { getApiErrorMessage, systemApi } from "@/lib/api";
import type { ComponentStatus, SetupComponentProgress, SetupLogEvent } from "@/lib/api/system";
import { useToast } from "@/context/ToastContext";
import { useSetupStream } from "@/hooks/useSetupStream";
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

const INPUT =
  "w-full px-3.5 py-2.5 rounded-xl border border-border/50 bg-muted/30 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none transition-all focus:ring-2 focus:ring-primary/20";

const LABEL = "block text-sm font-medium text-muted-foreground mb-1.5";

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
    .filter((component) => !component.status?.healthy && component.status?.installable !== false)
    .map((component) => component.name);
}

export default function AddServerPage() {
  const router = useRouter();
  const { showToast } = useToast();

  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [serverName, setServerName] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUser, setSshUser] = useState("root");
  const [sshAuthMethod, setSshAuthMethod] = useState<"password" | "key">(
    "password",
  );
  const [sshPassword, setSshPassword] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [sshKeyPassphrase, setSshKeyPassphrase] = useState("");
  const [tunnelProvider, setTunnelProvider] = useState<string>("");
  const [tunnelToken, setTunnelToken] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [jumpHost, setJumpHost] = useState("");
  const [extraArgs, setExtraArgs] = useState("");
  const [hasExistingServer, setHasExistingServer] = useState(false);

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
          const result = await systemApi.checkServer();
          setComponents((current) => buildComponentStates(result.components, current));
          setOverallReady(result.ready);
        } catch {
          // Keep whatever we have from the stream
        }
        if (event.status === "completed") {
          showToast("Server setup completed", "success", "Server Setup");
        } else {
          showToast("Some components failed to install", "error", "Server Setup");
        }
      })();
    },
  });

  const serverHostLabel = sshHost.trim() || serverName.trim() || "your server";

  useEffect(() => {
    (async () => {
      try {
        const settings = await systemApi.getSettings();
        if (settings?.configured && settings.sshHost) {
          setHasExistingServer(true);
          setServerName(settings.serverName ?? "");
          setSshHost(settings.sshHost);
          setSshPort(String(settings.sshPort ?? 22));
          setSshUser(settings.sshUser ?? "root");
          setSshAuthMethod(settings.sshAuthMethod === "key" ? "key" : "password");
          setSshKeyPath(settings.sshKeyPath ?? "");
          setJumpHost(settings.sshJumpHost ?? "");
          setExtraArgs(settings.sshArgs ?? "");
          setTunnelProvider(settings.tunnelProvider ?? "");
          if (settings.sshJumpHost || settings.sshArgs || settings.tunnelProvider) {
            setShowAdvanced(true);
          }

          // Check if there's an active install session (page reload recovery)
          try {
            const session = await systemApi.getInstallSession();
            if (session.active && session.status === "running" && session.sessionId) {
              setStep("installing");
              void setupStream.attachToSession(session.sessionId);
            }
          } catch {
            // No active session, that's fine
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

  async function runSetupChecks(selectedMode: SetupMode) {
    setMode(selectedMode);
    setSetupError(null);
    setStep("checking");

    try {
      const result = await systemApi.checkServer();
      setComponents((current) => buildComponentStates(result.components, current));
      setOverallReady(result.ready);
      setStep("results");
    } catch (err) {
      const message = getApiErrorMessage(err, "Health check failed");
      setOverallReady(false);
      setSetupError(message);
      setStep("choose");
      showToast(message, "error", "Server Setup");
    }
  }

  async function installComponents(targetNames?: string[]) {
    const names = (targetNames?.length ? targetNames : getMissingComponentNames(components))
      .filter((name, index, list) => list.indexOf(name) === index);

    if (names.length === 0) {
      setOverallReady(true);
      showToast("Server is already ready", "success", "Server Setup");
      return;
    }

    setSetupError(null);
    setStep("installing");

    try {
      await setupStream.startInstall(names);
    } catch (err) {
      const message = getApiErrorMessage(err, "Failed to start installation");
      setSetupError(message);
      showToast(message, "error", "Server Setup");
    }
  }

  async function handleSave() {
    if (!sshHost.trim()) {
      showToast("Server IP address is required", "error", "Server");
      return;
    }

    setSaving(true);
    try {
      const patch: Record<string, unknown> = {
        serverName: serverName.trim() || null,
        sshHost: sshHost.trim(),
        sshPort: parseInt(sshPort, 10) || 22,
        sshUser: sshUser.trim() || "root",
        sshAuthMethod,
        tunnelProvider: tunnelProvider || null,
        sshJumpHost: jumpHost.trim() || null,
        sshArgs: extraArgs.trim() || null,
      };

      if (sshAuthMethod === "password" && sshPassword) {
        patch.sshPassword = sshPassword;
      }
      if (sshAuthMethod === "key") {
        patch.sshKeyPath = sshKeyPath || null;
        if (sshKeyPassphrase) patch.sshKeyPassphrase = sshKeyPassphrase;
      }
      if (tunnelProvider && tunnelProvider !== "edge" && tunnelToken) {
        patch.tunnelToken = tunnelToken;
      }

      await systemApi.updateSettings(patch);
      setHasExistingServer(true);
      resetSetup();
      setStep("choose");
      showToast("Server saved", "success", "Server");
    } catch (err) {
      showToast(
        getApiErrorMessage(err, "Failed to save server"),
        "error",
        "Server",
      );
    } finally {
      setSaving(false);
    }
  }

  function handleSetupBack() {
    if (step === "installing" && !setupStream.isDone) return;
    if (step === "installing" && setupStream.isDone) {
      router.push("/servers/primary");
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
      <div className="min-h-screen bg-background">
        <div className="max-w-[1180px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
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
            />
          )}

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
              onDone={() => router.push("/servers/primary")}
            />
          )}

          {step === "installing" && (
            <InstallingPanel
              components={setupStream.components}
              logs={setupStream.logs}
              serverHost={serverHostLabel}
              isDone={setupStream.isDone}
              finalStatus={setupStream.finalStatus}
              onDone={() => router.push("/servers/primary")}
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
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => router.push("/servers")}
            className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center transition-colors"
          >
            <ArrowLeft className="size-4 text-muted-foreground" />
          </button>
          <div>
            <h1
              className="text-2xl font-medium text-foreground/80"
              style={{ letterSpacing: "-0.2px" }}
            >
              {hasExistingServer ? "Edit Server" : "Add Server"}
            </h1>
            <p className="text-sm text-muted-foreground/70 mt-0.5">
              Enter your server details and choose an auth method
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
          <div className="space-y-6 min-w-0">
            <div className="bg-card rounded-2xl border border-border/50">
              <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
                <div className="w-9 h-9 bg-blue-500/10 rounded-xl flex items-center justify-center">
                  <Server className="size-[18px] text-blue-500" />
                </div>
                <div>
                  <h2 className="font-semibold text-foreground text-[15px]">
                    SSH Connection
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Connect to your server via SSH
                  </p>
                </div>
              </div>

              <div className="p-5 space-y-[18px]">
                <div>
                  <label className={LABEL}>Server Name</label>
                  <input
                    type="text"
                    value={serverName}
                    onChange={(e) => setServerName(e.target.value)}
                    placeholder="e.g. Production, Staging, Dev..."
                    spellCheck={false}
                    autoComplete="off"
                    className={INPUT}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px] gap-3">
                  <div>
                    <label className={LABEL}>Server IP Address</label>
                    <input
                      type="text"
                      value={sshHost}
                      onChange={(e) => setSshHost(e.target.value)}
                      placeholder="123.45.67.89"
                      spellCheck={false}
                      autoComplete="off"
                      className={INPUT}
                    />
                  </div>
                  <div>
                    <label className={LABEL}>Port</label>
                    <input
                      type="text"
                      value={sshPort}
                      onChange={(e) => setSshPort(e.target.value)}
                      placeholder="e.g. 22"
                      className={INPUT}
                    />
                  </div>
                </div>

                <div>
                  <label className={LABEL}>Username</label>
                  <input
                    type="text"
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    placeholder="e.g. root"
                    spellCheck={false}
                    autoComplete="off"
                    className={INPUT}
                  />
                </div>

                <div>
                  <label className={LABEL}>Authentication</label>
                  <div className="flex gap-1 bg-muted/50 rounded-[10px] p-[3px] mb-3">
                    <button
                      type="button"
                      onClick={() => setSshAuthMethod("password")}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 text-[13px] font-medium rounded-lg transition-all ${
                        sshAuthMethod === "password"
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground/70"
                      }`}
                    >
                      <Lock className="size-3.5" />
                      Password
                    </button>
                    <button
                      type="button"
                      onClick={() => setSshAuthMethod("key")}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 text-[13px] font-medium rounded-lg transition-all ${
                        sshAuthMethod === "key"
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground/70"
                      }`}
                    >
                      <KeyRound className="size-3.5" />
                      SSH Key
                    </button>
                  </div>

                  {sshAuthMethod === "password" ? (
                    <div>
                      <label className={LABEL}>Password</label>
                      <input
                        type="password"
                        value={sshPassword}
                        onChange={(e) => setSshPassword(e.target.value)}
                        placeholder="Enter server password"
                        autoComplete="off"
                        className={INPUT}
                      />
                    </div>
                  ) : (
                    <div className="space-y-[18px]">
                      <div>
                        <label className={LABEL}>Key Path</label>
                        <input
                          type="text"
                          value={sshKeyPath}
                          onChange={(e) => setSshKeyPath(e.target.value)}
                          placeholder="~/.ssh/id_rsa"
                          spellCheck={false}
                          autoComplete="off"
                          className={INPUT}
                        />
                      </div>
                      <div>
                        <label className={LABEL}>
                          Passphrase{" "}
                          <span className="text-muted-foreground/50 font-normal">
                            (optional)
                          </span>
                        </label>
                        <input
                          type="password"
                          value={sshKeyPassphrase}
                          onChange={(e) => setSshKeyPassphrase(e.target.value)}
                          placeholder="Enter passphrase or leave blank"
                          autoComplete="off"
                          className={INPUT}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
                >
                  <ChevronDown
                    className={`size-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
                  />
                  Advanced
                </button>

                {showAdvanced && (
                  <div className="space-y-[18px]">
                    <div>
                      <label className={LABEL}>Tunnel Provider</label>
                      <div className="relative">
                        <select
                          value={tunnelProvider}
                          onChange={(e) => setTunnelProvider(e.target.value)}
                          className="w-full px-3.5 py-2.5 pr-9 rounded-xl border border-border/50 bg-muted/30 text-sm text-foreground appearance-none outline-none transition-all focus:ring-2 focus:ring-primary/20"
                        >
                          <option value="">None (public IP)</option>
                          <option value="edge">Openship Edge (managed)</option>
                          <option value="cloudflare">Cloudflare Tunnel</option>
                          <option value="ngrok">ngrok</option>
                        </select>
                        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                      </div>

                      {tunnelProvider && tunnelProvider !== "edge" && (
                        <div className="mt-[18px]">
                          <label className={LABEL}>
                            {tunnelProvider === "cloudflare"
                              ? "Cloudflare Tunnel Token"
                              : "ngrok Auth Token"}
                          </label>
                          <input
                            type="password"
                            value={tunnelToken}
                            onChange={(e) => setTunnelToken(e.target.value)}
                            placeholder={
                              tunnelProvider === "cloudflare"
                                ? "eyJhIjoi..."
                                : "2abc123def..."
                            }
                            autoComplete="off"
                            className={INPUT}
                          />
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className={LABEL}>
                          Jump Host{" "}
                          <span className="text-muted-foreground/50 font-normal">
                            (optional)
                          </span>
                        </label>
                        <input
                          type="text"
                          value={jumpHost}
                          onChange={(e) => setJumpHost(e.target.value)}
                          placeholder="user@bastion.example.com"
                          spellCheck={false}
                          autoComplete="off"
                          className={INPUT}
                        />
                      </div>
                      <div>
                        <label className={LABEL}>
                          Extra SSH Arguments{" "}
                          <span className="text-muted-foreground/50 font-normal">
                            (optional)
                          </span>
                        </label>
                        <input
                          type="text"
                          value={extraArgs}
                          onChange={(e) => setExtraArgs(e.target.value)}
                          placeholder="-o StrictHostKeyChecking=no"
                          spellCheck={false}
                          autoComplete="off"
                          className={INPUT}
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div className="pt-1">
                  <button
                    onClick={handleSave}
                    disabled={saving || !sshHost.trim()}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {saving ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Check className="size-4" />
                    )}
                    Save &amp; Continue to Setup
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <div className="bg-card rounded-2xl border border-border/50">
              <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
                <div className="w-9 h-9 bg-violet-500/10 rounded-xl flex items-center justify-center">
                  <Info className="size-[18px] text-violet-500" />
                </div>
                <div>
                  <h2 className="font-semibold text-foreground text-[15px]">
                    Getting Started
                  </h2>
                  <p className="text-xs text-muted-foreground">What you need</p>
                </div>
              </div>
              <div className="p-5">
                <ul className="space-y-3 text-sm text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <Network className="size-4 shrink-0 mt-0.5 text-blue-500" />
                    <span>
                      A server with SSH access (Ubuntu, Debian, or similar)
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <KeyRound className="size-4 shrink-0 mt-0.5 text-blue-500" />
                    <span>SSH key or password for authentication</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Server className="size-4 shrink-0 mt-0.5 text-blue-500" />
                    <span>
                      After saving, Openship will run checks and install the
                      missing backend-defined prerequisites for you.
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
