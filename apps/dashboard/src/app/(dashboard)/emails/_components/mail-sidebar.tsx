"use client";

import {
  Mail,
  Shield,
  CheckCircle2,
  ExternalLink,
  RotateCcw,
  AlertTriangle,
  Loader2,
  Unplug,
  OctagonX,
  ArrowRightLeft,
  Skull,
} from "lucide-react";
import type { MailSetupStatus, DnsRecords, PortConflict } from "@/lib/api";
import { DnsRecordCard } from "./dns-record-card";

interface CompletionData {
  webmailUrl: string;
  adminUrl: string;
  mailDomain: string;
}

interface MailSidebarProps {
  domain: string;
  status: MailSetupStatus | null;
  dnsRecords: DnsRecords | null;
  completionData: CompletionData | null;
  portConflicts: PortConflict[] | null;
  resolving: boolean;
  running: boolean;
  isCompleted: boolean;
  onResolveConflict: (conflict: PortConflict, resolutionId: string) => void;
  onResume: (fromStep: number) => void;
}

export function MailSidebar({
  domain,
  status,
  dnsRecords,
  completionData,
  portConflicts,
  resolving,
  running,
  isCompleted,
  onResolveConflict,
  onResume,
}: MailSidebarProps) {
  return (
    <div className="space-y-4">
      {/* Port conflict resolution */}
      {portConflicts && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-5">
          <div className="flex items-center gap-3 mb-4">
            <Unplug className="size-5 text-amber-500" />
            <div>
              <h3 className="text-sm font-semibold text-amber-600 dark:text-amber-400">
                Port Conflict Detected
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Ports 80/443 are needed for the mail server
              </p>
            </div>
          </div>

          {portConflicts.length > 0 ? (
            <div className="space-y-4">
              {portConflicts.map((conflict) => (
                <div
                  key={conflict.port}
                  className="rounded-xl border border-border/50 bg-card p-4"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono px-2 py-0.5 rounded-md bg-muted text-muted-foreground">
                        :{conflict.port}
                      </span>
                      <span className="text-sm font-medium text-foreground">
                        {conflict.serviceName ?? conflict.usage.process}
                      </span>
                    </div>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        conflict.type === "traefik"
                          ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                          : conflict.type === "known"
                            ? "bg-violet-500/10 text-violet-600 dark:text-violet-400"
                            : "bg-red-500/10 text-red-600 dark:text-red-400"
                      }`}
                    >
                      {conflict.type === "traefik"
                        ? "Managed"
                        : conflict.type === "known"
                          ? "Known Service"
                          : "Unknown"}
                    </span>
                  </div>

                  {conflict.usage.containerName && (
                    <p className="text-xs text-muted-foreground mb-2">
                      Container: {conflict.usage.containerName}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground mb-3">
                    PID {conflict.usage.pid}
                    {conflict.usage.isDocker ? " (Docker)" : ""}
                  </p>

                  <div className="space-y-2">
                    {conflict.resolutions.map((resolution) => (
                      <button
                        key={resolution.id}
                        onClick={() => onResolveConflict(conflict, resolution.id)}
                        disabled={resolving}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors disabled:opacity-50 ${
                          resolution.destructive
                            ? "border-red-500/30 hover:bg-red-500/5"
                            : "border-border/50 hover:bg-muted/50"
                        }`}
                      >
                        {resolution.destructive ? (
                          resolution.id === "kill_process" ? (
                            <Skull className="size-4 text-red-500 shrink-0" />
                          ) : (
                            <OctagonX className="size-4 text-red-500 shrink-0" />
                          )
                        ) : (
                          <ArrowRightLeft className="size-4 text-blue-500 shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p
                            className={`text-sm font-medium ${
                              resolution.destructive
                                ? "text-red-600 dark:text-red-400"
                                : "text-foreground"
                            }`}
                          >
                            {resolution.label}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {resolution.description}
                          </p>
                        </div>
                        {resolving && (
                          <Loader2 className="size-4 animate-spin text-muted-foreground shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>

                  {conflict.type === "unknown" && (
                    <div className="mt-3 flex items-start gap-2 p-2.5 rounded-lg bg-red-500/5">
                      <AlertTriangle className="size-3.5 text-red-500 mt-0.5 shrink-0" />
                      <p className="text-xs text-red-600 dark:text-red-400">
                        Make sure this process is not needed before killing
                        it. This action cannot be undone.
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
              <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                All conflicts resolved
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Re-run the port check and continue the setup.
              </p>
              <button
                onClick={() => onResume(3)}
                disabled={resolving || running}
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                <RotateCcw className="size-3.5" />
                Resume from Step 3
              </button>
            </div>
          )}
        </div>
      )}

      {/* Completion card */}
      {isCompleted && completionData && (
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-5">
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle2 className="size-5 text-emerald-500" />
            <h3 className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
              Mail Server Ready!
            </h3>
          </div>
          <div className="space-y-3">
            <a
              href={completionData.webmailUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-border/50 bg-card hover:border-border transition-colors"
            >
              <Mail className="size-4 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Webmail</p>
                <p className="text-xs text-muted-foreground truncate">
                  {completionData.webmailUrl}
                </p>
              </div>
              <ExternalLink className="size-3.5 text-muted-foreground shrink-0" />
            </a>
            <a
              href={completionData.adminUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-border/50 bg-card hover:border-border transition-colors"
            >
              <Shield className="size-4 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Admin Panel</p>
                <p className="text-xs text-muted-foreground truncate">
                  {completionData.adminUrl}
                </p>
              </div>
              <ExternalLink className="size-3.5 text-muted-foreground shrink-0" />
            </a>
          </div>
        </div>
      )}

      {/* DNS Records */}
      {dnsRecords && (
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <h3 className="text-sm font-semibold text-foreground mb-4">
            Required DNS Records
          </h3>
          <p className="text-xs text-muted-foreground mb-4">
            Add these records to your domain&apos;s DNS provider
          </p>
          <div className="space-y-3">
            <DnsRecordCard label="DKIM" record={dnsRecords.dkim} />
            <DnsRecordCard label="MX Record" record={dnsRecords.mx} />
            <DnsRecordCard label="SPF" record={dnsRecords.spf} />
            <DnsRecordCard label="DMARC" record={dnsRecords.dmarc} />
          </div>
        </div>
      )}

      {/* Setup domain info */}
      {domain && (
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <h3 className="text-sm font-semibold text-foreground mb-3">Setup Details</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Domain</dt>
              <dd className="font-medium text-foreground">{domain}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Mail Server</dt>
              <dd className="font-medium text-foreground">mail.{domain}</dd>
            </div>
            {status?.startedAt && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Started</dt>
                <dd className="font-medium text-foreground">
                  {new Date(status.startedAt).toLocaleTimeString()}
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}
