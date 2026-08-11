import { api, getApiBaseUrl, getActiveOrganizationId } from "./client";
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

export interface MailSessionLogLine {
  stepId: number;
  level: "info" | "warn" | "error";
  message: string;
  ts: number;
}

// ─── Health-check types ──────────────────────────────────────────────────────

export type MailComponentStatus =
  | "active"
  | "inactive"
  | "failed"
  | "activating"
  | "deactivating"
  | "missing"
  | "unknown";

export interface MailComponentHealth {
  key: string;
  label: string;
  description: string;
  unit: string;
  status: MailComponentStatus;
  subState?: string;
  activeSince?: string;
}

export interface MailComponentDef {
  key: string;
  label: string;
  description: string;
  unit: string;
}

export interface MailHealthResponse {
  serverId: string;
  components: MailComponentHealth[];
  definitions: MailComponentDef[];
}

/**
 * Postmaster identity + IMAP/SMTP host info. The password is never sent
 * to the client - it lives only as a hash in vmail.mailbox. Operators set
 * a known password via the Change flow when they need one.
 */
export interface MailCredentials {
  username: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
}

/**
 * Webmail (Zero) install record. `installed=true` means a successful
 * deploy has happened against this mail server. Absent or `installed=false`
 * means the overview tab should show the Deploy CTA instead of an Open
 * webmail button. The `brandingToken` is NEVER exposed here - that secret
 * lives between the openship API and the Zero server only.
 */
export interface MailWebmailSummary {
  installed: boolean;
  targetServerId: string;
  hostname: string;
  url: string;
  internalPort: number;
  deployedAt: string;
  version: string;
}

export interface MailSetupStatus {
  active: boolean;
  serverId?: string;
  domain?: string;
  currentStep?: number;
  startedAt?: number;
  finishedAt?: number;
  dnsRecords?: Record<string, unknown>;
  /**
   * Whether the operator has clicked "I've set the records - continue" on
   * a prior visit. False while the install is paused at the DKIM hold;
   * flips true once they ack so subsequent retries don't pause again.
   */
  dnsAcknowledged?: boolean;
  /**
   * Whether the operator has acknowledged the PTR (reverse DNS) gate that
   * follows DNS ack. PTRs are at the VPS provider, not the DNS provider -
   * separate gate to avoid mixing the two.
   */
  ptrAcknowledged?: boolean;
  credentials?: MailCredentials;
  /** Webmail deploy record. Absent when no webmail is deployed yet. */
  webmail?: MailWebmailSummary;
  steps: MailStepStatus[];
  /** Server-buffered log lines, rehydrated on page reload. */
  logs?: MailSessionLogLine[];
  /** Step the user should resume from after a failure / port conflict. */
  resumeStep?: number;
  /** Last failure message - populated when a step failed or conflict halted. */
  errorMessage?: string;
}

// ─── Webmail deploy types ────────────────────────────────────────────────────

export interface WebmailTargetOption {
  kind: "mail" | "server" | "opshcloud";
  serverId: string;
  label: string;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  /** MX priority. Other record types ignore this. */
  priority?: number;
  /** False = optional helper, not required for mail delivery. */
  required?: boolean;
}

export interface DnsRecords {
  // Host records - pre-install requirement (A) + optional IPv6 (AAAA).
  // Surfaced as cards for completeness even though A is already in place
  // by the time the user sees them.
  a?: DnsRecord;
  aaaa?: DnsRecord;
  // Required for mail delivery
  mx: DnsRecord;
  spf: DnsRecord;
  dkim: DnsRecord;
  dmarc: DnsRecord;
  /**
   * Extra records beyond the fixed set — e.g. the outbound-relay send-hop
   * records (SES DKIM CNAMEs + MAIL FROM). Rendered after the standard records.
   */
  extraRecords?: DnsRecord[];
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

/**
 * DKIM hold-and-continue gate. Emitted after step 11 (DKIM keys) when the
 * user hasn't yet acknowledged DNS records. The install pauses until the
 * user calls `mailApi.acknowledgeDns(...)` and then re-POSTs to /mail/setup
 * with `startStep = resumeStep`.
 */
export interface MailSSEDnsPending {
  event: "dns_pending";
  records: DnsRecords;
  resumeStep: number;
}

/**
 * PTR (reverse-DNS) hold gate. Emitted AFTER `dns_pending` is resolved.
 * PTRs are configured at the VPS provider's panel - separate from the
 * DNS provider - so this gate gets its own banner to avoid mixing them.
 */
export interface MailSSEPtrPending {
  event: "ptr_pending";
  ipv4: string;
  ipv6: string | null;
  target: string;
  resumeStep: number;
}

export type MailSSEEvent =
  | MailSSEStepStart
  | MailSSELog
  | MailSSEStepDone
  | MailSSEDnsRecords
  | MailSSEDnsPending
  | MailSSEPtrPending
  | MailSSEComplete
  | MailSSEError
  | MailSSEPortConflict;

// ─── API client ──────────────────────────────────────────────────────────────

export const mailApi = {
  /** Get list of all setup steps */
  getSteps: () =>
    api.get<{ steps: MailSetupStep[]; total: number }>(endpoints.mail.steps),

  /**
   * Get current setup status for a server. State lives ON the target
   * VPS now (not in openship's DB), so a serverId is required to know
   * whose state we're reading. Returns the "no install" shape if the
   * server can't be reached or the state file doesn't exist.
   */
  getStatus: (serverId?: string) =>
    api.get<MailSetupStatus>(
      serverId
        ? `${endpoints.mail.status}?serverId=${encodeURIComponent(serverId)}`
        : endpoints.mail.status,
    ),

  /**
   * List every server that has a mail install (state file) on disk. Used by
   * the /emails page to short-circuit the picker when there's exactly one
   * mail server provisioned. Servers without a state file or unreachable
   * over SSH are omitted; the dashboard treats this list as the authoritative
   * "which servers are mail servers" set.
   */
  listMailServers: () =>
    api.get<{
      servers: Array<{
        id: string;
        name: string;
        host: string;
        port: number;
        user: string;
        domain: string | null;
        completed: boolean;
        active: boolean;
      }>;
    }>(endpoints.mail.servers),

  /**
   * Scan a server for an EXISTING mail install whose orchestrator state was
   * lost (e.g. a rebuilt desktop). Read-only.
   */
  scan: (serverId: string) =>
    api.post<{
      serverId: string;
      iredmailInstalled: boolean;
      hasState: boolean;
      domain: string | null;
      installComplete: boolean;
      webmailPresent: boolean;
      adoptable: boolean;
    }>(endpoints.mail.scan, { serverId }),

  /**
   * Re-adopt a mail server detected by `scan` — repopulates the dashboard's
   * record from the on-server state. Idempotent; nothing changes on the server.
   */
  adopt: (serverId: string) =>
    api.post<{ success: boolean; serverId: string; domain: string; completed: boolean }>(
      endpoints.mail.adopt,
      { serverId },
    ),

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
    // EventSource only supports GET - we need a custom approach
    // See streamSetup below for the POST+SSE pattern
    es.close();

    // Not usable directly - use streamSetup instead
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
    // Direct fetch bypasses the standard api client, so we must attach
    // X-Organization-Id ourselves — otherwise the server scopes by
    // cookie (`activeOrganizationId`) only, which can be stale in a
    // multi-tab session and resolve to the wrong org.
    const orgId = getActiveOrganizationId();
    const setupHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (orgId) setupHeaders["X-Organization-Id"] = orgId;
    const res = await fetch(url.toString(), {
      method: "POST",
      credentials: "include",
      headers: setupHeaders,
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

  /**
   * Wipe the on-server state file. Use after purging or reimaging the VPS
   * so the dashboard stops showing stale "step 9 complete" data.
   */
  resetSetup: (serverId: string) =>
    api.post<{ ok: boolean }>(endpoints.mail.resetSetup, { serverId }),

  /**
   * Stop managing a mail server: drops only the mail_servers DB row so
   * /emails stops listing it. The mail stack + on-server state file are
   * left intact, so it can be re-adopted later via scan + adopt. Use to
   * clear a stale/corrupted registry entry.
   */
  forget: (serverId: string) =>
    api.delete<{ ok: boolean }>(endpoints.mail.forgetServer(serverId)),

  /**
   * Mark DNS records as configured for a (server, domain) session - releases
   * the install past the DKIM hold step. The caller should follow this with
   * a `streamSetup(..., startStep = resumeStep)` to actually resume.
   */
  acknowledgeDns: (serverId: string, domain: string) =>
    api.post<{ ok: boolean }>(endpoints.mail.acknowledgeDns, {
      serverId,
      domain,
    }),

  /**
   * Mark PTR (reverse DNS) as configured - releases the install past the
   * VPS-provider gate that runs after DNS ack. Same call shape as DNS ack.
   */
  acknowledgePtr: (serverId: string) =>
    api.post<{ ok: boolean }>(endpoints.mail.acknowledgePtr, {
      serverId,
    }),

  /**
   * Rotate the postmaster password. Hashes via doveadm on the server and
   * UPDATEs `vmail.mailbox` directly. Refuses if a setup is currently
   * running against this server.
   */
  setPostmasterPassword: (serverId: string, password: string) =>
    api.post<{ ok: boolean }>(endpoints.mail.setPostmasterPassword, {
      serverId,
      password,
    }),

  /**
   * Live health of every mail-core daemon on the target server. The Mail
   * tab polls this every ~10 s to render running/stopped pills.
   */
  getHealth: (serverId: string) =>
    api.get<MailHealthResponse>(endpoints.mail.health(serverId)),

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

  // ── Webmail deploy ────────────────────────────────────────────────────────
  webmail: {
    /** Hosts the webmail can be deployed to (mail server + other openship servers). */
    listTargets: (serverId: string) =>
      api.get<{ options: WebmailTargetOption[] }>(
        `${endpoints.mail.webmail.targets}?serverId=${encodeURIComponent(serverId)}`,
      ),

    /**
     * Create a project + deployment for this webmail install and kick off
     * the deploy in the background. The dashboard then redirects to
     * /build/[deploymentId] and subscribes to the standard SSE endpoint.
     *
     * `target` discriminator:
     *   { kind: "self", serverId } - host on an openship-managed server
     *   { kind: "cloud" }          - host on Opshcloud
     */
    deployAsProject: (input: {
      mailServerId: string;
      hostname: string;
      internalPort?: number;
      target:
        | { kind: "self"; serverId: string }
        | { kind: "cloud" };
    }) =>
      api.post<{ deploymentId: string; projectId: string }>(
        endpoints.mail.webmail.deployProject,
        input,
      ),

    /**
     * Deploy the Zero webmail UI pointed at an EXTERNAL IMAP/SMTP backend —
     * the "Connect existing" provider path (Amazon SES for send + a read IMAP
     * host, or a fully custom backend). No mail server / iRedMail required.
     */
    deployExternal: (input: {
      hostname: string;
      backend: {
        provider: "ses" | "custom";
        imapHost: string;
        imapPort: number;
        smtpHost: string;
        smtpPort: number;
      };
      target: { deployTarget: "server" | "cloud" | "local"; serverId?: string };
      internalPort?: number;
    }) =>
      api.post<{ deploymentId: string; projectId: string }>(
        endpoints.mail.webmail.deployExternal,
        input,
      ),
  },
};

