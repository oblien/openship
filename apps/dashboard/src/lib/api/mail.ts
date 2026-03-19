import { api, getApiBaseUrl } from "./client";
import { endpoints } from "./endpoints";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MailSetupStep {
  id: number;
  key: string;
  label: string;
  description: string;
}

export interface MailStepStatus extends MailSetupStep {
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  message?: string;
  warning?: string;
  data?: Record<string, unknown>;
}

export interface MailSetupStatus {
  active: boolean;
  serverId?: string;
  domain?: string;
  currentStep?: number;
  startedAt?: number;
  finishedAt?: number;
  dnsRecords?: Record<string, unknown>;
  steps: MailStepStatus[];
}

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  priority?: number;
}

export interface DnsRecords {
  dkim: DnsRecord;
  mx: DnsRecord;
  spf: DnsRecord;
  dmarc: DnsRecord;
}

// ─── Port conflict types ─────────────────────────────────────────────────────

export interface PortUsage {
  port: number;
  pid: number;
  process: string;
  command: string;
  isDocker: boolean;
  containerName?: string;
}

export interface PortResolution {
  id: string;
  label: string;
  description: string;
  destructive: boolean;
}

export interface PortConflict {
  port: number;
  usage: PortUsage;
  type: "traefik" | "known" | "unknown";
  serviceName?: string;
  resolutions: PortResolution[];
}

// ─── SSE event types ─────────────────────────────────────────────────────────

export interface MailSSEStepStart {
  event: "step_start";
  stepId: number;
  key: string;
  label: string;
}

export interface MailSSELog {
  event: "log";
  stepId: number;
  level: "info" | "warn" | "error";
  message: string;
}

export interface MailSSEStepDone {
  event: "step_done";
  stepId: number;
  success: boolean;
  message: string;
  warning?: string;
  data?: Record<string, unknown>;
}

export interface MailSSEDnsRecords {
  event: "dns_records";
  records: DnsRecords;
}

export interface MailSSEComplete {
  event: "complete";
  success: boolean;
  domain: string;
  mailDomain: string;
  finishedAt: number;
  webmailUrl: string;
  adminUrl: string;
}

export interface MailSSEError {
  event: "error";
  message: string;
  resumeStep?: number;
}

export interface MailSSEPortConflict {
  event: "port_conflict";
  portConflicts: PortConflict[];
}

export type MailSSEEvent =
  | MailSSEStepStart
  | MailSSELog
  | MailSSEStepDone
  | MailSSEDnsRecords
  | MailSSEComplete
  | MailSSEError
  | MailSSEPortConflict;

// ─── API client ──────────────────────────────────────────────────────────────

export const mailApi = {
  /** Get list of all setup steps */
  getSteps: () =>
    api.get<{ steps: MailSetupStep[]; total: number }>(endpoints.mail.steps),

  /** Get current setup status */
  getStatus: () =>
    api.get<MailSetupStatus>(endpoints.mail.status),

  /**
   * Start or resume the mail setup wizard.
   * Returns an EventSource for SSE streaming.
   */
  startSetup: (
    serverId: string,
    domain: string,
    startStep?: number,
    config?: { adminPassword: string; storageBackend?: "mariadb" | "postgresql" },
  ): EventSource => {
    const url = new URL(endpoints.mail.setup, getApiBaseUrl());

    // We POST to start the setup, which returns SSE
    // We use fetch + ReadableStream approach for POST-based SSE
    const body = JSON.stringify({
      serverId,
      domain,
      ...(startStep ? { startStep } : {}),
      ...(config ? { config } : {}),
    });

    // Store body for the streaming function
    const es = new EventSource(url.toString());
    // EventSource only supports GET — we need a custom approach
    // See streamSetup below for the POST+SSE pattern
    es.close();

    // Not usable directly — use streamSetup instead
    return es;
  },

  /**
   * Stream setup progress via POST + SSE using fetch ReadableStream.
   */
  streamSetup: async (
    serverId: string,
    domain: string,
    startStep: number | undefined,
    config: { adminPassword: string; storageBackend?: "mariadb" | "postgresql" } | undefined,
    onEvent: (event: MailSSEEvent) => void,
    onDone?: () => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const url = new URL(endpoints.mail.setup, getApiBaseUrl());
    const res = await fetch(url.toString(), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        domain,
        ...(startStep ? { startStep } : {}),
        ...(config ? { config } : {}),
      }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Setup failed: ${res.status}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE frames
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let eventType = "";
      let eventData = "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          eventData = line.slice(5).trim();
        } else if (line === "" && eventType && eventData) {
          try {
            const parsed = JSON.parse(eventData);
            onEvent({ event: eventType, ...parsed } as MailSSEEvent);
          } catch {
            // Skip malformed events
          }
          eventType = "";
          eventData = "";
        }
      }
    }

    onDone?.();
  },

  /** Cancel a running setup */
  cancelSetup: () =>
    api.post<{ ok: boolean; message: string }>(endpoints.mail.cancelSetup),

  /** Standalone port 80/443 scan */
  checkPorts: (serverId: string) =>
    api.post<{ conflicts: PortConflict[]; free: boolean }>(endpoints.mail.portsCheck, {
      serverId,
    }),

  /** Resolve a specific port conflict */
  resolvePorts: (serverId: string, conflict: PortConflict, resolutionId: string) =>
    api.post<{ success: boolean; message: string }>(endpoints.mail.portsResolve, {
      serverId,
      conflict,
      resolutionId,
    }),
};
