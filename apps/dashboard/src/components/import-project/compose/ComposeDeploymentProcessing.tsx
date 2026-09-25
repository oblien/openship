"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useEffect, useMemo, useRef, useState } from "react";

import DeploymentDetails from "../DeploymentDetails";
import BuildTerminal from "../BuildTerminal";
import { DeploymentHeader } from "../DeploymentHeader";
import { DeploymentLayout } from "../DeploymentLayout";
import { DeploymentLogsPanel } from "../DeploymentLogsPanel";
import { PageContainer } from "@/components/ui/PageContainer";
import { Tabs } from "@/components/ui/Tabs";
import { ServiceStatusIndicator } from "@/components/services/ServiceStatusBadge";
import { PortAdvisoryModal } from "../PortAdvisoryModal";
import { PromptDetails } from "../PromptDetails";
import { useRouter } from "next/navigation";
import { useDeployment } from "@/context/DeploymentContext";
import { useModal } from "@/context/ModalContext";
import { useCloudDeployPricing } from "@/hooks/useCloudDeployPricing";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/context/ToastContext";
import { useTheme } from "@/components/theme-provider";
import { deployApi, projectsApi } from "@/lib/api";
import { composeServiceTally, serviceLogSource } from "@/context/deployment/types";
import { LiveServiceLogsTerminal } from "./LiveServiceLogsTerminal";
import type { DeploymentStatus, ServiceDeployStatus } from "@/context/deployment/types";
import type { BuildLog } from "@/utils/deploymentPhaseDetector";
import { useI18n, interpolate } from "@/components/i18n-provider";

const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

// The shared clone/context-prep stream (one clone for the whole deployment, not
// one per service) has no serviceName, so it gets its own tab instead of being
// dropped or duplicated across per-service tabs.
const PREPARE_TAB = "__prepare__";

// ─── Main Component ──────────────────────────────────────────────────────────

interface Props {
  // Resolves to the new deployment id (navigates on success) or null on failure.
  onRedeploy: () => void | Promise<string | null>;
}

const ComposeDeploymentProcessing: React.FC<Props> = ({ onRedeploy }) => {
  const { config, state, onTerminalReady, respondToPrompt, deploymentStatus } =
    useDeployment();
  const { showModal, hideModal } = useModal();
  const showCloudPricing = useCloudDeployPricing();
  const { showToast } = useToast();
  const { resolvedTheme } = useTheme();
  const { t } = useI18n();
  const cd = t.importProject.composeDeployment;
  const router = useRouter();
  const promptModalRef = React.useRef<string | null>(null);
  // Tracks which deployment's decision dialog we've already auto-opened, so it
  // pops once (not on every re-render) while staying re-openable via the banner.
  const autoOpenedDecisionRef = React.useRef<string | null>(null);
  const [decisionModalOpen, setDecisionModalOpen] = useState(false);
  const [decisionResolved, setDecisionResolved] = useState(false);
  const [activeLogTab, setActiveLogTab] = useState("");
  // Once the user picks a tab, stop auto-following the active phase.
  const [userPinnedTab, setUserPinnedTab] = useState(false);
  const handleTabChange = (tab: string) => {
    setUserPinnedTab(true);
    setActiveLogTab(tab);
  };
  // Last actively-building/deploying service — auto-follow releases a stale
  // manual pin when this advances to a new service.
  const prevWorkingRef = useRef<string | undefined>(undefined);

  const hasWarning = deploymentStatus === "ready" && !!state.warningMessage;
  // A partial-failure deploy held for an explicit keep/reject decision. Driven
  // by the server-backed `decisionPending` flag (survives refresh), suppressed
  // locally once the user acts this session.
  const showDecision = state.decisionPending && !decisionResolved;
  const isFinished =
    deploymentStatus === "ready" ||
    deploymentStatus === "failed" ||
    deploymentStatus === "cancelled";
  const services = state.serviceStatuses;
  const projectId = state.projectId || config.projectId;
  const [liveDeploymentId, setLiveDeploymentId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLiveDeploymentId(null);
    if (deploymentStatus === "ready" && !showDecision && projectId && state.deploymentId) {
      void projectsApi.getInfo(projectId).then(response => {
        if (active) setLiveDeploymentId(response.data?.project?.activeDeploymentId ?? null);
      }).catch(() => { /* Keep build history when current ownership cannot be verified. */ });
    }
    return () => { active = false; };
  }, [deploymentStatus, showDecision, projectId, state.deploymentId]);
  const logServiceNames = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    // Source-built services (build/dockerfile) emit real build logs; static
    // image-only services (postgres, redis) just get pulled. Surface the
    // buildable ones first so the first tab — and the default selection — lands
    // on a service with meaningful logs instead of a static image pull.
    const buildFirst = [...config.services].sort((a, b) => {
      const aStatic = a.build || a.dockerfile ? 0 : 1;
      const bStatic = b.build || b.dockerfile ? 0 : 1;
      return aStatic - bStatic;
    });
    buildFirst.forEach((service) => {
      if (service.name && !seen.has(service.name)) {
        seen.add(service.name);
        ordered.push(service.name);
      }
    });
    services.forEach((service) => {
      if (service.serviceName && !seen.has(service.serviceName)) {
        seen.add(service.serviceName);
        ordered.push(service.serviceName);
      }
    });
    // Also surface any service that has already produced live log lines, even
    // if config.services / serviceStatuses haven't hydrated yet. Without this,
    // a per-service line whose name isn't yet in the roster is coerced to the
    // Prepare tab (parseLogLines) and only lands in its own tab after a refresh
    // repopulates the roster from getBuildStatus.
    state.buildLogs.forEach((log) => {
      if (log.serviceName && !seen.has(log.serviceName)) {
        seen.add(log.serviceName);
        ordered.push(log.serviceName);
      }
    });
    return ordered;
  }, [config.services, services, state.buildLogs]);
  // `total` stays local — this panel counts services that have produced log lines
  // but aren't in the roster yet. Counts use the same resolver as the details.
  const total = Math.max(services.length, logServiceNames.length);
  const { running, built, failed } = composeServiceTally(services);
  const settled = running + built + failed;
  const terminalTheme = resolvedTheme === "light" ? "light" : "dark"; // dim → dark

  useEffect(() => {
    onTerminalReady();
  }, [onTerminalReady]);

  // Auto-follow the active phase: the shared "Prepare" (clone/transfer) stream
  // first, then whichever service is currently building/deploying — advancing
  // to the next one as each settles. Stops the moment the user picks a tab.
  useEffect(() => {
    const statusByName = new Map(services.map((s) => [s.serviceName, s.status]));
    const working = logServiceNames.find((name) => {
      const status = statusByName.get(name);
      return status === "building" || status === "deploying";
    });

    // When the build advances to a NEW actively-building/deploying service,
    // release a stale manual pin so auto-follow re-engages on the live service.
    // Without this the first tab click freezes the view forever (the pin was
    // never reset), stranding the user on an empty/not-yet-built tab.
    if (working && working !== prevWorkingRef.current) {
      prevWorkingRef.current = working;
      if (userPinnedTab) {
        setUserPinnedTab(false);
        return; // re-runs with the pin cleared, then follows below
      }
    }

    if (userPinnedTab) return;

    // Follow the actively-building/deploying service. When nothing is working:
    // on first mount (no tab chosen yet) land on Prepare; otherwise stay put —
    // don't bounce back to Prepare in the gap between the build and deploy phases.
    const target = working ?? (activeLogTab ? null : PREPARE_TAB);
    if (target && target !== activeLogTab) {
      setActiveLogTab(target);
    }
  }, [userPinnedTab, services, logServiceNames, activeLogTab]);

  // ── Pipeline prompt modal ──────────────────────────────────────────────
  useEffect(() => {
    if (!state.pendingPrompt) return;
    const { promptId, title, message, actions, details } = state.pendingPrompt;
    if (promptModalRef.current === promptId) return;
    promptModalRef.current = promptId;

    const modalId = showModal({
      title,
      icon: "warning",
      customContent: (
        <div className="p-6 space-y-5">
          <div className="space-y-2">
            <h3 className="text-xl font-bold text-foreground">{title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{message}</p>
          </div>

          <PromptDetails details={details} />

          <div className="flex items-center justify-end gap-3 pt-2">
            {actions.map((action) => {
              const variant = (action.variant || "secondary") as "secondary" | "danger" | "primary";
              const styles =
                variant === "danger"
                  ? "bg-danger-solid text-white hover:bg-danger-solid/90"
                  : variant === "primary"
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "bg-secondary text-secondary-foreground hover:bg-secondary/80";
              return (
                <button
                  key={action.id}
                  type="button"
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${styles}`}
                  onClick={() => {
                    hideModal(modalId);
                    respondToPrompt(action.id);
                  }}
                >
                  {action.label}
                </button>
              );
            })}
          </div>
        </div>
      ),
      width: "560px",
      maxWidth: "92vw",
    });
  }, [state.pendingPrompt, showModal, hideModal, respondToPrompt]);

  const handleKeepDeployment = React.useCallback(async () => {
    if (state.deploymentId) {
      try {
        await deployApi.keep(state.deploymentId);
      } catch {
        // Best-effort: dismiss locally even if the confirm call fails — the
        // banner reappears from the server flag on refresh if it didn't persist.
      }
    }
    setDecisionResolved(true);
    setDecisionModalOpen(false);
    showToast(cd.toast.keptMsg, "success", cd.toast.keptTitle);
  }, [state.deploymentId, showToast, cd]);

  const handleRejectDeployment = React.useCallback(async () => {
    if (!state.deploymentId) return;
    await deployApi.reject(state.deploymentId);
    setDecisionResolved(true);
    setDecisionModalOpen(false);
    showToast(cd.toast.rejectedMsg, "success", cd.toast.rejectedTitle);
    if (state.projectId) router.push(`/projects/${state.projectId}`);
  }, [state.deploymentId, state.projectId, router, showToast, cd]);

  const retryInFlightRef = React.useRef(false);
  const handleRetryFailed = React.useCallback(async () => {
    if (retryInFlightRef.current) return; // one retry press = one POST
    // Rebuild ONLY the failed services — the successful ones carry forward on
    // their existing containers (compose carry-forward). Prefer the live
    // per-service statuses, but after a refresh the build session (and those
    // statuses) is gone — fall back to the server's authoritative failed list
    // from the held decision so Retry still works instead of silently no-op'ing.
    const liveFailedIds = state.serviceStatuses
      .filter((s) => s.status === "failed" && s.serviceId)
      .map((s) => s.serviceId);
    const failedIds = liveFailedIds.length > 0 ? liveFailedIds : state.decisionFailedServiceIds;
    if (failedIds.length === 0 || !state.projectId) {
      setDecisionResolved(true);
      setDecisionModalOpen(false);
      return;
    }
    retryInFlightRef.current = true;
    // Resolve + close optimistically the instant we act. The new deployment
    // supersedes the old partial's pending decision server-side at create, so the
    // banner/modal must not linger OR re-arm — leaving the retry armed on failure
    // is exactly what re-POSTed into the in-progress lock and spammed 403s.
    setDecisionResolved(true);
    setDecisionModalOpen(false);
    try {
      const res = await deployApi.trigger({ projectId: state.projectId, serviceIds: failedIds });
      const newId = res?.data?.deployment?.id;
      router.push(newId ? `/build/${newId}` : `/projects/${state.projectId}`);
    } catch (err) {
      if (showCloudPricing(err)) {
        // A quota refusal created no build. Keep the failed-service retry available.
        setDecisionResolved(false);
        return;
      }
      // Usually a deploy is already in progress (the previous retry) → 403. Do
      // NOT re-fire; send the user to the project where the running deploy shows.
      showToast(err instanceof Error ? err.message : cd.toast.retryFailMsg, "error", cd.toast.retryTitle);
      router.push(`/projects/${state.projectId}`);
    } finally {
      retryInFlightRef.current = false;
    }
  }, [state.serviceStatuses, state.decisionFailedServiceIds, state.projectId, router, showToast, showCloudPricing, cd]);

  // Auto-open the decision dialog once per deployment when a partial failure is
  // awaiting a decision. Closing it leaves the persistent banner in place, so the
  // decision stays re-openable — and reappears after a refresh via the server
  // `decisionPending` flag — until the user keeps or rejects it.
  useEffect(() => {
    if (!showDecision || !state.deploymentId) return;
    if (autoOpenedDecisionRef.current === state.deploymentId) return;
    autoOpenedDecisionRef.current = state.deploymentId;
    setDecisionModalOpen(true);
  }, [showDecision, state.deploymentId]);

  return (
    <PageContainer>
      <DeploymentHeader onRedeploy={onRedeploy} serviceCount={total} decisionPending={showDecision} />

      <ComposeDeploymentBody
        logs={state.buildLogs}
        serviceNames={logServiceNames}
        services={services}
        activeTab={activeLogTab}
        onTabChange={handleTabChange}
        deploymentStatus={deploymentStatus}
        decisionPending={showDecision}
        projectId={projectId}
        deploymentId={state.deploymentId ?? undefined}
        isCurrentDeployment={!!state.deploymentId && liveDeploymentId === state.deploymentId}
        settled={settled}
        total={total}
        isFinished={isFinished}
        terminalTheme={terminalTheme}
      >
        {/* Decision banner — persists while a partial deploy awaits keep/reject
            (survives refresh via the server flag). Re-opens the dialog. */}
        {showDecision ? (
          <div className="rounded-2xl border border-warning-border bg-warning-bg px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-warning">
                  {cd.decisionBannerTitle}
                </p>
                <p className="mt-1 text-sm text-warning">
                  {state.warningMessage || cd.decisionBannerDefaultMsg}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDecisionModalOpen(true)}
                className="shrink-0 rounded-lg bg-warning-solid px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-warning-solid/90"
              >
                {cd.review}
              </button>
            </div>
          </div>
        ) : hasWarning ? (
          <div className="rounded-2xl border border-warning-border bg-warning-bg px-5 py-4">
            <p className="text-sm font-medium text-warning">
              {cd.warningTitle}
            </p>
            <p className="mt-1 text-sm text-warning">
              {state.warningMessage}
            </p>
          </div>
        ) : null}

        {deploymentStatus === "ready" && (
          <PortAdvisoryModal
            deploymentId={state.deploymentId}
            projectId={state.projectId || config.projectId}
            checks={state.portCheck}
            skipped={state.portCheckSkipped}
            isCompose
          />
        )}
      </ComposeDeploymentBody>

      {showDecision && decisionModalOpen && (
        <Modal
          isOpen
          onClose={() => setDecisionModalOpen(false)}
          closable
          showCloseButton={false}
          maxWidth="640px"
        >
          <PartialSuccessModalContent
            failed={failed}
            total={total}
            warningMessage={state.warningMessage}
            onKeep={handleKeepDeployment}
            onRetry={handleRetryFailed}
            onReject={handleRejectDeployment}
          />
        </Modal>
      )}
    </PageContainer>
  );
};

export default ComposeDeploymentProcessing;

interface ParsedLogLine {
  text: string;
  type: BuildLog["type"];
  serviceName: string | null;
  rawData?: string;
}

function stripAnsi(text: string) {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function textForDetection(text: string) {
  return stripAnsi(text)
    .replace(/\r/g, "\n")
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trimEnd() ?? "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectServiceName(text: string, serviceNames: string[]) {
  const prefixed = text.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (prefixed) {
    const serviceName = prefixed[1];
    if (serviceNames.includes(serviceName)) {
      return serviceName;
    }
  }

  const composed = text.match(
    /\b(?:building|built|deploying|starting|started|stopping|creating|created|preparing|running|failed)\s+(?:compose\s+)?service\s+"([^"]+)"/i,
  );
  if (composed && serviceNames.includes(composed[1])) {
    return composed[1];
  }

  for (const name of serviceNames) {
    const servicePattern = new RegExp(`\\bservice\\s+"${escapeRegExp(name)}"\\b`, "i");
    if (servicePattern.test(text)) {
      return name;
    }
  }

  return null;
}

function stripServicePrefixFromChunk(text: string, serviceName: string) {
  const prefixPattern = new RegExp(`(^|[\\r\\n])\\[${escapeRegExp(serviceName)}\\]\\s*`, "g");
  return text.replace(prefixPattern, "$1") || text;
}

function parseLogLines(
  logs: BuildLog[],
  serviceNames: string[],
  serviceIdToName: Map<string, string>,
): ParsedLogLine[] {
  return logs
    .map((log) => {
      const rawText = log.text;
      const detectionText = textForDetection(rawText);
      // Route by the STABLE serviceId → canonical name first (roster-independent,
      // works before serviceStatuses hydrate); then trust the line's own
      // serviceName tag WITHOUT the roster `includes` gate — that gate dropped
      // early live lines into Prepare; finally fall back to text detection for
      // untagged shared lines.
      const taggedName =
        (log.serviceId ? serviceIdToName.get(log.serviceId) : undefined) ??
        (log.serviceName || undefined);
      const structuredService = taggedName
        ? {
            serviceName: taggedName,
            text: stripServicePrefixFromChunk(rawText, taggedName),
          }
        : null;
      const detectedServiceName = structuredService?.serviceName ?? detectServiceName(detectionText, serviceNames);
      const text = detectedServiceName
        ? stripServicePrefixFromChunk(structuredService?.text ?? rawText, detectedServiceName)
        : rawText;

      return {
        text,
        serviceName: detectedServiceName,
        type: log.type,
        rawData: log.rawData,
      };
    })
    .filter((log) => log.text.trim().length > 0);
}

function ComposeDeploymentBody({
  children,
  logs,
  serviceNames,
  services,
  activeTab,
  onTabChange,
  deploymentStatus,
  decisionPending,
  projectId,
  deploymentId,
  isCurrentDeployment,
  settled,
  total,
  isFinished,
  terminalTheme,
}: {
  children: React.ReactNode;
  logs: BuildLog[];
  serviceNames: string[];
  services: ServiceDeployStatus[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  deploymentStatus: DeploymentStatus;
  /** Held keep/reject decision — suppresses the runtime-stream swap (#667). */
  decisionPending?: boolean;
  /** Needed to dial each service's live runtime log stream after success. */
  projectId?: string;
  deploymentId?: string;
  isCurrentDeployment: boolean;
  settled: number;
  total: number;
  isFinished: boolean;
  terminalTheme: "light" | "dark";
}) {
  const { t } = useI18n();
  const cd = t.importProject.composeDeployment;
  const serviceIdToName = useMemo(() => {
    const map = new Map<string, string>();
    services.forEach((service) => {
      if (service.serviceId && service.serviceName) map.set(service.serviceId, service.serviceName);
    });
    return map;
  }, [services]);
  const serviceIdByName = useMemo(() => {
    const map = new Map<string, string>();
    services.forEach((service) => {
      if (service.serviceId && service.serviceName) map.set(service.serviceName, service.serviceId);
    });
    return map;
  }, [services]);
  const parsedLogs = useMemo(
    () => parseLogLines(logs, serviceNames, serviceIdToName),
    [logs, serviceNames, serviceIdToName],
  );
  const serviceStatusByName = useMemo(() => {
    const statuses = new Map<string, ServiceDeployStatus["status"]>();
    services.forEach((service) => statuses.set(service.serviceName, service.status));
    return statuses;
  }, [services]);
  const hasFinished =
    deploymentStatus === "ready" ||
    deploymentStatus === "failed" ||
    deploymentStatus === "cancelled";
  const terminalTabs = useMemo(() => {
    const byService = new Map<string, ParsedLogLine[]>();
    serviceNames.forEach((serviceName) => byService.set(serviceName, []));

    // Logs with no serviceName are the shared prepare stream (one clone +
    // context transfer for the whole deployment) — collect them into Prepare.
    const prepareLogs: ParsedLogLine[] = [];
    parsedLogs.forEach((log) => {
      if (!log.serviceName) {
        prepareLogs.push(log);
        return;
      }
      const bucket = byService.get(log.serviceName);
      // A tagged line whose service isn't in the roster (roster gap) is surfaced
      // in Prepare rather than silently dropped by the missing bucket.
      if (bucket) bucket.push(log);
      else prepareLogs.push(log);
    });

    const serviceTabs = serviceNames.map((serviceName) => ({
      id: serviceName,
      label: serviceName,
      logs: byService.get(serviceName) ?? [],
      emptyMessage: hasFinished
        ? interpolate(cd.noLogsFor, { service: serviceName })
        : interpolate(cd.waitingFor, { service: serviceName }),
    }));

    return [
      {
        id: PREPARE_TAB,
        label: cd.prepareTab,
        logs: prepareLogs,
        emptyMessage: hasFinished
          ? cd.noPrepareLogs
          : cd.preparingContext,
      },
      ...serviceTabs,
    ];
  }, [hasFinished, parsedLogs, serviceNames, cd]);

  const tabPrefix = React.useId();
  const selectedTab = terminalTabs.find(tab => tab.id === activeTab) ?? terminalTabs[0];
  const selectedTabId = selectedTab.id;
  // Prepare carries the shared orchestration output through the whole deployment.
  // Reflect that workflow's status; an image being built does not finish this stream.
  const deploymentLabels = t.importProject.deploymentProcessing.status;
  const prepareIndicator = {
    building: { status: "building", label: deploymentLabels.building },
    deploying: { status: "deploying", label: t.importProject.serviceStatus.deploying },
    ready: { status: "running", label: deploymentLabels.ready },
    failed: { status: "failed", label: deploymentLabels.failed },
    cancelled: { status: "stopped", label: deploymentLabels.cancelled },
  }[deploymentStatus];
  const usesRuntimeLogs = (name: string) => name !== PREPARE_TAB && !!projectId && !!deploymentId &&
    !!serviceIdByName.get(name) && serviceLogSource({
      deploymentStatus, decisionPending, isCurrentDeployment,
      serviceStatus: serviceStatusByName.get(name),
    }) === "runtime";

  return (
    <DeploymentLayout
      details={<DeploymentDetails />}
      navigation={
        <div className="rounded-2xl bg-card p-3">
          {!isFinished && total > 0 && (
            <div className="mx-3 mb-3 mt-1 h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={cd.title.deploying} aria-valuemin={0} aria-valuemax={total} aria-valuenow={settled}>
              <div className="h-full bg-primary transition-all duration-500" style={{ width: `${(settled / total) * 100}%` }} />
            </div>
          )}
          <Tabs
            value={selectedTabId}
            onChange={onTabChange}
            idPrefix={tabPrefix}
            ariaLabel={cd.logsTitle}
            columns={2}
            className="max-h-80"
            tabs={terminalTabs.map(tab => {
              const status = serviceStatusByName.get(tab.id) ?? "pending";
              const indicator = tab.id === PREPARE_TAB
                ? prepareIndicator
                : { status, label: t.importProject.serviceStatus[status] };
              return {
                key: tab.id,
                label: tab.label,
                leading: (
                  <span className="inline-flex size-4 shrink-0 items-center justify-center">
                    <ServiceStatusIndicator {...indicator} />
                  </span>
                ),
              };
            })}
          />
        </div>
      }
    >
      {children}
      <DeploymentLogsPanel
        title={usesRuntimeLogs(selectedTabId) ? t.importProject.deploymentProcessing.productionLogs : cd.logsTitle}
        summary={<span className="min-w-0 flex-1 truncate text-end text-sm text-muted-foreground" title={selectedTab.label}>{selectedTab.label}</span>}
      >
        {terminalTabs.map(tab => {
          const serviceId = serviceIdByName.get(tab.id);
          const active = selectedTabId === tab.id;
          // Keep inactive consoles sized for xterm's fit. Opacity also hides its
          // .visible scrollbars, which override the inherited visibility:hidden.
          return (
            <div
              key={tab.id}
              id={`${tabPrefix}-panel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`${tabPrefix}-tab-${tab.id}`}
              aria-hidden={!active}
              tabIndex={active ? 0 : -1}
              className={`absolute inset-0 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2 ${active ? "" : "invisible pointer-events-none opacity-0"}`}
            >
              {usesRuntimeLogs(tab.id) && projectId && deploymentId && serviceId ? (
                <LiveServiceLogsTerminal projectId={projectId} deploymentId={deploymentId} serviceId={serviceId} active={active} theme={terminalTheme} />
              ) : (
                <ComposeLogTerminal logs={tab.logs} active={active} emptyMessage={tab.emptyMessage} theme={terminalTheme} />
              )}
            </div>
          );
        })}
      </DeploymentLogsPanel>
    </DeploymentLayout>
  );
}

function terminalLine(log: ParsedLogLine) {
  const text = log.text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const hasAnsi = text.includes("\x1B");
  const suffix = /[\r\n]/.test(log.text) ? "" : "\r\n";
  if (hasAnsi) return `${text}${suffix}`;
  if (log.type === "error") return `\x1b[31m${text}\x1b[0m${suffix}`;
  if (log.type === "success") return `\x1b[32m${text}\x1b[0m${suffix}`;
  return `${text}${suffix}`;
}

function terminalBytes(log: ParsedLogLine) {
  if (!log.rawData) {
    return terminalLine(log);
  }

  try {
    const binary = atob(log.rawData);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return terminalLine(log);
  }
}

function isTerminalAtBottom(terminal: any) {
  const buffer = terminal?.buffer?.active;
  if (!buffer) return true;
  return buffer.viewportY >= buffer.baseY - 1;
}

function ComposeLogTerminal({
  logs,
  active,
  emptyMessage,
  theme,
}: {
  logs: ParsedLogLine[];
  active: boolean;
  emptyMessage: string;
  theme: "light" | "dark";
}) {
  const terminalRef = useRef<any | null>(null);
  const writtenCountRef = useRef(0);
  const prevActiveRef = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !ready) return;

    const becameActive = active && !prevActiveRef.current;
    prevActiveRef.current = active;

    // Repaint from scratch when this tab is (re)opened, or if the buffer was
    // trimmed. xterm's DOM renderer does not reliably paint rows written while
    // the tab was hidden (visibility:hidden), so a service that streamed its
    // build output while another tab was focused would otherwise look empty
    // (only the first line survives) until this forces a full re-render.
    if (becameActive || logs.length < writtenCountRef.current) {
      terminal.reset();
      writtenCountRef.current = 0;
    }

    const shouldScroll = becameActive || (active && isTerminalAtBottom(terminal));
    logs.slice(writtenCountRef.current).forEach((log) => {
      terminal.write(terminalBytes(log));
    });
    writtenCountRef.current = logs.length;
    if (shouldScroll) {
      terminal.scrollToBottom();
    }
  }, [active, logs, ready]);

  return (
    <div
      className="absolute inset-0"
      style={{
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
      }}
      aria-hidden={!active}
    >
      <BuildTerminal
        active={active}
        onReady={(terminal) => {
          terminalRef.current = terminal;
          setReady(true);
        }}
        theme={theme}
        enableContainerStreaming={false}
      />
      {active && logs.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center">
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        </div>
      )}
    </div>
  );
}

function PartialSuccessModalContent({
  failed,
  total,
  warningMessage,
  onKeep,
  onRetry,
  onReject,
}: {
  failed: number;
  total: number;
  warningMessage: string;
  onKeep: () => void;
  onRetry: () => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const { t } = useI18n();
  const p = t.importProject.composeDeployment.partial;
  const [isRejecting, setIsRejecting] = React.useState(false);
  const [isRetrying, setIsRetrying] = React.useState(false);
  const busy = isRejecting || isRetrying;

  return (
    <div className="p-6 space-y-5">
      <div className="space-y-2">
        <h3 className="text-xl font-bold text-foreground">
          {p.title}
        </h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {interpolate(p.body, { failed: String(failed), total: String(total) })}
        </p>
      </div>

      <div className="rounded-xl border border-warning-border bg-warning-bg p-4 space-y-2">
        <p className="text-xs uppercase tracking-wide text-warning">
          {p.warning}
        </p>
        <p className="text-sm text-warning/90">{warningMessage}</p>
      </div>

      <div className="rounded-xl border border-border bg-muted/40 p-4">
        <p className="text-sm text-muted-foreground">
          {p.rejectNote}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
        <button
          type="button"
          className="rounded-lg border border-border bg-muted px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/80 disabled:opacity-50"
          onClick={onKeep}
          disabled={busy}
        >
          {p.keep}
        </button>
        <button
          type="button"
          className="rounded-lg bg-danger-solid px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-danger-solid/90 disabled:opacity-50"
          onClick={async () => {
            setIsRejecting(true);
            try {
              await onReject();
            } finally {
              setIsRejecting(false);
            }
          }}
          disabled={busy}
        >
          {isRejecting ? (
            <span className="inline-flex items-center gap-2">
              <UiIcon name="spinner" className="w-4 h-4 animate-spin" />
              {p.rejecting}
            </span>
          ) : (
            p.reject
          )}
        </button>
        <button
          type="button"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          onClick={async () => {
            setIsRetrying(true);
            try {
              await onRetry();
            } finally {
              setIsRetrying(false);
            }
          }}
          disabled={busy}
        >
          {isRetrying ? (
            <span className="inline-flex items-center gap-2">
              <UiIcon name="spinner" className="w-4 h-4 animate-spin" />
              {p.retrying}
            </span>
          ) : (
            interpolate(failed === 1 ? p.retryOne : p.retryOther, { count: String(failed) })
          )}
        </button>
      </div>
    </div>
  );
}
