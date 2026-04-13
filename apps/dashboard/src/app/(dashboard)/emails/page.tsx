"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2 } from "lucide-react";
import {
  mailApi,
  systemApi,
  type MailSetupStatus,
  type DnsRecords,
  type MailSSEEvent,
  type PortConflict,
} from "@/lib/api";
import type { ServerOption } from "@/components/shared/ServerSelector";
import { PageContainer } from "@/components/ui/PageContainer";
import { MailSetupForm } from "./_components/mail-setup-form";
import { MailProgress } from "./_components/mail-progress";
import { MailSidebar } from "./_components/mail-sidebar";

export default function EmailsPage() {
  const [status, setStatus] = useState<MailSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [domain, setDomain] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [logs, setLogs] = useState<Array<{ stepId: number; level: string; message: string }>>([]);
  const [dnsRecords, setDnsRecords] = useState<DnsRecords | null>(null);
  const [completionData, setCompletionData] = useState<{
    webmailUrl: string;
    adminUrl: string;
    mailDomain: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumeStep, setResumeStep] = useState<number | null>(null);
  const [portConflicts, setPortConflicts] = useState<PortConflict[] | null>(null);
  const [resolving, setResolving] = useState(false);
  const [selectedServer, setSelectedServer] = useState<ServerOption | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Fetch mail status on mount
  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const s = await mailApi.getStatus();
      setStatus(s);
      if (s.domain) setDomain(s.domain);
      if (s.dnsRecords) setDnsRecords(s.dnsRecords as unknown as DnsRecords);
      if (s.active) setRunning(true);
      if (s.serverId) {
        try {
          const server = await systemApi.getServerById(s.serverId);
          setSelectedServer({
            id: server.id,
            name: server.name || server.sshHost,
            host: server.sshHost,
            user: server.sshUser || "root",
            port: server.sshPort ?? 22,
            raw: server,
          });
        } catch {
          setSelectedServer(null);
        }
      }
    } catch {
      // No status yet — fresh setup
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Start setup
  const handleStart = useCallback(
    async (fromStep?: number) => {
      if (!domain || !selectedServer?.id) return;
      setRunning(true);
      setError(null);
      setLogs([]);
      setPortConflicts(null);
      setCompletionData(null);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await mailApi.streamSetup(
          selectedServer.id,
          domain,
          fromStep,
          adminPassword ? { adminPassword } : undefined,
          (event: MailSSEEvent) => {
            switch (event.event) {
              case "step_start":
                setStatus((prev) => {
                  if (!prev) return prev;
                  return {
                    ...prev,
                    currentStep: event.stepId,
                    steps: prev.steps.map((s) =>
                      s.id === event.stepId ? { ...s, status: "running" as const } : s,
                    ),
                  };
                });
                break;

              case "log":
                setLogs((prev) => [
                  ...prev,
                  { stepId: event.stepId, level: event.level, message: event.message },
                ]);
                break;

              case "step_done":
                if (event.stepId === 3 && event.success) {
                  setPortConflicts(null);
                }
                setStatus((prev) => {
                  if (!prev) return prev;
                  return {
                    ...prev,
                    steps: prev.steps.map((s) =>
                      s.id === event.stepId
                        ? {
                            ...s,
                            status: event.success ? ("completed" as const) : ("failed" as const),
                            message: event.message,
                            warning: event.warning,
                            data: event.data,
                          }
                        : s,
                    ),
                  };
                });
                break;

              case "dns_records":
                setDnsRecords(event.records);
                break;

              case "port_conflict":
                setPortConflicts(event.portConflicts);
                break;

              case "complete":
                setCompletionData({
                  webmailUrl: event.webmailUrl,
                  adminUrl: event.adminUrl,
                  mailDomain: event.mailDomain,
                });
                setRunning(false);
                break;

              case "error":
                setError(event.message);
                if (event.resumeStep) setResumeStep(event.resumeStep);
                setRunning(false);
                break;
            }
          },
          () => setRunning(false),
          controller.signal,
        );
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          setError(err.message);
        }
        setRunning(false);
      }
    },
    [domain, adminPassword, selectedServer],
  );

  const handleCancel = useCallback(async () => {
    abortRef.current?.abort();
    try {
      await mailApi.cancelSetup();
    } catch {
      // Already stopped
    }
    setRunning(false);
  }, []);

  const handleResolveConflict = useCallback(
    async (conflict: PortConflict, resolutionId: string) => {
      if (!selectedServer?.id) {
        setError("Select a server first");
        return;
      }
      setResolving(true);
      setError(null);
      try {
        const result = await mailApi.resolvePorts(selectedServer.id, conflict, resolutionId);
        if (result.success) {
          // Remove resolved conflict from list
          setPortConflicts((prev) => {
            if (!prev) return [];
            const remaining = prev.filter((c) => c.port !== conflict.port);
            return remaining;
          });
          setLogs((prev) => [
            ...prev,
            { stepId: 3, level: "info", message: result.message },
          ]);
        } else {
          setError(result.message);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Resolution failed");
      } finally {
        setResolving(false);
      }
    },
    [selectedServer],
  );

  // Check if setup has been completed before
  const isCompleted =
    status?.steps?.every((s) => s.status === "completed") || !!completionData;
  const hasStarted = status?.steps?.some(
    (s) => s.status === "completed" || s.status === "failed",
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <PageContainer>
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1
              className="text-2xl font-medium text-foreground/80"
              style={{ letterSpacing: "-0.2px" }}
            >
              Email Server
            </h1>
            <p className="text-sm text-muted-foreground/70 mt-1">
              Set up a self-hosted mail server with a few clicks
            </p>
          </div>
        </div>

        {/* ── Welcome state — server selector + setup form ── */}
        {!hasStarted && !running && (
          <MailSetupForm
            domain={domain}
            adminPassword={adminPassword}
            running={running}
            selectedServerId={selectedServer?.id ?? null}
            onDomainChange={setDomain}
            onPasswordChange={setAdminPassword}
            onServerSelect={setSelectedServer}
            onStart={() => handleStart()}
          />
        )}

        {/* ── Setup in progress / completed ── */}
        {(hasStarted || running) && (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6">
            <MailProgress
              steps={status?.steps ?? []}
              logs={logs}
              running={running}
              error={error}
              resumeStep={resumeStep}
              logsEndRef={logsEndRef}
              onCancel={handleCancel}
              onResume={handleStart}
            />
            <MailSidebar
              domain={domain}
              status={status}
              dnsRecords={dnsRecords}
              completionData={completionData}
              portConflicts={portConflicts}
              resolving={resolving}
              running={running}
              isCompleted={isCompleted}
              onResolveConflict={handleResolveConflict}
              onResume={handleStart}
            />
          </div>
        )}
    </PageContainer>
  );
}
