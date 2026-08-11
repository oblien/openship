import { AlertTriangle, KeyRound, RefreshCw, Settings2, ShieldAlert, Unplug, Wifi, WifiOff } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  classifyConnectivityError,
  HOST_CHANNEL_PROVISION_COMMAND,
  type ConnectivityCode,
} from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { HostChannelCode } from "@/lib/api/system";

export type ConnectionErrorKind =
  | "unreachable"   // can't reach the host at all (ECONNREFUSED / ETIMEDOUT / no route)
  | "auth"          // SSH connected but credentials rejected
  | "no_server"     // no server row / invalid config
  /** THIS box: the container→host SSH channel is blocked (#490) or was never
   *  provisioned (#509). Which one is read off the diagnosis, not the kind. */
  | "host_channel"
  | "unknown";

/** Map the unified ConnectivityCode down to the banner's coarser kinds. */
const CODE_TO_KIND: Record<ConnectivityCode, ConnectionErrorKind> = {
  reachable: "unknown",
  auth_failed: "auth",
  unreachable: "unreachable",
  timeout: "unreachable",
  protocol_error: "unknown",
  permission_denied: "unknown",
  misconfigured: "no_server",
  unknown: "unknown",
};

/**
 * Classify an SSH check error into something the UI can show actionable copy
 * for. Prefers an explicit `code` from the unified connectivity result; else
 * falls back to the shared core classifier over the legacy `error` tag +
 * message (single source of truth, shared with the backend).
 */
export function classifyConnectionError(
  body: unknown,
  message: string,
): ConnectionErrorKind {
  const code = (body && typeof body === "object" && "code" in body)
    ? ((body as { code?: ConnectivityCode | "host_channel_blocked" }).code)
    : undefined;
  // Not a ConnectivityCode: the API diagnosed THIS box's container→host channel, so
  // the generic "can't reach {sshHost}" copy would name the wrong machine (#490).
  if (code === "host_channel_blocked") return "host_channel";
  if (code) return CODE_TO_KIND[code] ?? "unknown";

  const tag = (body && typeof body === "object" && "error" in body)
    ? ((body as { error?: unknown }).error as string | undefined)
    : undefined;
  return CODE_TO_KIND[classifyConnectivityError(message, tag).code] ?? "unknown";
}

/**
 * The endpoint + remedy the API attached to the failure. Present only for
 * `host_channel_blocked`, where the row's own `sshHost` is the wrong address to
 * show — see the API's ReachabilityDiagnosis.
 *
 * It also decides WHICH host-channel state this is, because the remedy differs: a
 * channel that was dialed and didn't answer wants a host firewall rule, one that
 * was never provisioned wants `openship up` (#509).
 */
export interface ConnectionDiagnosis {
  /** The address the API DIALED. Absent when there was no endpoint to dial. */
  target?: string | null;
  /**
   * The address the channel WILL use once provisioned. Never probed, so it is
   * rendered as intent and never as a machine that failed to answer (#509).
   */
  intendedTarget?: string | null;
  /** Which host-channel state this is, refining `host_channel_blocked`. */
  channel?: HostChannelCode | null;
  hint?: string | null;
  rule?: string | null;
}

export function readConnectionDiagnosis(body: unknown): ConnectionDiagnosis | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as ConnectionDiagnosis;
  if (!b.target && !b.intendedTarget && !b.channel && !b.hint && !b.rule) return undefined;
  return {
    target: b.target,
    intendedTarget: b.intendedTarget,
    channel: b.channel,
    hint: b.hint,
    rule: b.rule,
  };
}

/**
 * The address the API actually dialed, or null when it dialed nothing.
 *
 * The #509 state is containerized with no OPENSHIP_HOST_SSH_HOST: there is no
 * endpoint, so no probe ran and the health carries a remedy and nothing else. Read
 * from the explicit channel code when the API sends one — an endpoint on that code
 * is intent, not evidence — else from the absence of a target, since "no address"
 * and "no dial" are the same fact.
 *
 * There is deliberately no fallback to the row's `sshHost`: that is how this banner
 * came to report nothing answering on 127.0.0.1:22, a machine that was never the
 * target and a port that is supposed to be closed (#490).
 */
function dialedTarget(d?: ConnectionDiagnosis): string | null {
  if (d?.channel === "not_configured") return null;
  return d?.target || null;
}

export function ConnectionBanner(props: {
  serverId: string;
  kind: ConnectionErrorKind;
  host: string;
  port: number;
  message: string;
  retrying: boolean;
  onRetry: () => void;
  diagnosis?: ConnectionDiagnosis;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const { kind, host, port, message, retrying, onRetry, serverId, diagnosis } = props;

  const dialed = dialedTarget(diagnosis);

  const copy = (() => {
    switch (kind) {
      case "host_channel":
        // Nothing dialed → the channel was never provisioned, so no address can be
        // named as unresponsive and nothing here is down (#509).
        return dialed === null
          ? {
              title: t.servers.banner.hostChannelMissingTitle,
              body: t.servers.banner.hostChannelMissingBody,
              icon: Unplug,
              tone: "amber",
            }
          : {
              title: t.servers.banner.hostChannelTitle,
              body: interpolate(t.servers.banner.hostChannelBody, { target: dialed }),
              icon: ShieldAlert,
              tone: "amber",
            };
      case "unreachable":
        return {
          title: interpolate(t.servers.banner.unreachableTitle, { host }),
          body: interpolate(t.servers.banner.unreachableBody, { host, port: String(port) }),
          icon: WifiOff,
          tone: "amber",
        };
      case "auth":
        return {
          title: t.servers.banner.authTitle,
          body: interpolate(t.servers.banner.authBody, { host, port: String(port) }),
          icon: KeyRound,
          tone: "red",
        };
      case "no_server":
        return {
          title: t.servers.banner.noServerTitle,
          body: t.servers.banner.noServerBody,
          icon: AlertTriangle,
          tone: "amber",
        };
      default:
        return {
          title: t.servers.banner.unknownTitle,
          body: message || t.servers.banner.unknownBody,
          icon: AlertTriangle,
          tone: "amber",
        };
    }
  })();

  /**
   * The pasteable remedy under "Fix:". For an unprovisioned channel it is
   * `openship up`, which needs nothing measured on the host — so the block does not
   * depend on the API attaching a command, and a firewall rule is never offered: no
   * packet ever left, so no packet filter has been established (#509).
   *
   * The command comes from @repo/core, not a literal here: it is quoted on five surfaces
   * and the whole point of that module is that they can't word it differently.
   */
  const fix = kind !== "host_channel"
    ? null
    : dialed === null
      ? { label: t.servers.banner.hostChannelProvisionFix, command: HOST_CHANNEL_PROVISION_COMMAND }
      : diagnosis?.rule
        ? { label: t.servers.banner.hostChannelFix, command: diagnosis.rule }
        : null;

  const tone = copy.tone === "red"
    ? "bg-danger-bg border-danger-border text-danger"
    : "bg-warning-bg border-warning-border text-warning";
  const iconBg = copy.tone === "red"
    ? "bg-danger-bg text-danger"
    : "bg-warning-bg text-warning";

  return (
    <div className={`rounded-2xl border p-4 mb-6 ${tone}`}>
      <div className="flex items-start gap-3">
        <div className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${iconBg}`}>
          <copy.icon className="size-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">{copy.title}</p>
          <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">{copy.body}</p>
          {kind === "unreachable" && (
            <ul className="text-[12px] text-muted-foreground/80 mt-2 list-disc ps-5 space-y-0.5">
              <li>{t.servers.banner.checkPowered}</li>
              <li><code className="font-mono">ping {host}</code> {t.servers.banner.pingSuffix}</li>
              <li><code className="font-mono">nc -zv {host} {port}</code> {interpolate(t.servers.banner.ncSuffix, { port: String(port) })}</li>
            </ul>
          )}
          {kind === "host_channel" && (
            <>
              <p className="text-[12px] text-muted-foreground/80 mt-2 leading-relaxed">
                {t.servers.banner.hostChannelImpact}
              </p>
              {dialed === null && diagnosis?.intendedTarget && (
                <p className="text-[12px] text-muted-foreground/70 mt-2 leading-relaxed">
                  {interpolate(t.servers.banner.hostChannelWouldUse, {
                    target: diagnosis.intendedTarget,
                  })}
                </p>
              )}
              {diagnosis?.hint && (
                <p className="text-[12px] text-muted-foreground/70 mt-2 leading-relaxed">
                  {diagnosis.hint}
                </p>
              )}
              {fix && (
                <div className="mt-2">
                  <p className="text-[12px] text-muted-foreground/80">{fix.label}</p>
                  <pre className="text-[11px] font-mono mt-1 p-2 rounded-lg bg-foreground/[0.04] text-muted-foreground/80 whitespace-pre-wrap break-all">
                    {fix.command}
                  </pre>
                </div>
              )}
            </>
          )}
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <button
              onClick={onRetry}
              disabled={retrying}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-foreground/[0.06] hover:bg-foreground/[0.1] text-foreground rounded-lg transition-colors disabled:opacity-50"
            >
              {retrying ? <RefreshCw className="size-3 animate-spin" /> : <Wifi className="size-3" />}
              {retrying ? t.servers.banner.checking : t.servers.banner.retry}
            </button>
            <button
              onClick={() => router.push(`/servers/${serverId}?edit=true`)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-foreground/[0.06] hover:bg-foreground/[0.1] text-foreground rounded-lg transition-colors"
            >
              <Settings2 className="size-3" />
              {kind === "auth" ? t.servers.banner.editCredentials : t.servers.banner.editServer}
            </button>
          </div>
          {message && kind !== "unknown" && (
            <details className="mt-2.5">
              <summary className="text-[11px] text-muted-foreground/70 cursor-pointer hover:text-muted-foreground">
                {t.servers.banner.showRawError}
              </summary>
              <pre className="text-[11px] font-mono mt-1.5 p-2 rounded-lg bg-foreground/[0.04] text-muted-foreground/80 whitespace-pre-wrap break-all">
                {message}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
