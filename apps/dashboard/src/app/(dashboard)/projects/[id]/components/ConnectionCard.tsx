"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Eye, EyeOff, Loader2, Link2, MonitorSmartphone, PlugZap } from "lucide-react";
import { appsApi, type AppConnectionOutput, type AppConnectionView } from "@/lib/api/apps";
import { systemApi } from "@/lib/api";
import { usePlatform } from "@/context/PlatformContext";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import { UseInProjectModal } from "./UseInProjectModal";

/** Port from an `http(s)://host:port` or `scheme://…@host:port/…` value, if any. */
function portOf(value: string): number | null {
  try {
    const p = new URL(value).port;
    return p ? Number(p) : null;
  } catch {
    return null;
  }
}

/**
 * Connection card for a catalog app — surfaces the deploy's connection details
 * (public URL, generated keys) so the user copies them into the app / client SDK
 * rather than shelling in. Everything comes pre-resolved from one authoritative
 * endpoint (`GET /projects/:id/app-connection`): env values are read from the
 * backing services (written once at install, decrypted for this authorized read)
 * and `publicUrl` sources are resolved to the assigned domain or host:port. The
 * template gates WHICH values are shown. Renders nothing for apps without one.
 *
 * Desktop + a remote-server app: each host:port value gets an "Open on localhost"
 * action that forwards the remote port to this machine over the existing SSH
 * tunnel (never shown on a VPS/cloud, which are already reachable directly).
 */
export function ConnectionCard({
  projectId,
  appTemplateId,
  serverId,
  deployTarget,
}: {
  projectId: string;
  appTemplateId?: string | null;
  serverId?: string | null;
  deployTarget?: string | null;
}) {
  const [view, setView] = useState<AppConnectionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [linkOpen, setLinkOpen] = useState(false);
  const { deployMode } = usePlatform();
  const { showToast } = useToast();
  const { t } = useI18n();
  // Forwarding to localhost only makes sense from a desktop dashboard managing a
  // REMOTE server (a local app is already localhost; a VPS is already public).
  const canForward = deployMode === "desktop" && deployTarget === "server" && !!serverId;

  useEffect(() => {
    if (!appTemplateId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await appsApi.getConnection(projectId).catch(() => null);
        if (!cancelled) setView(res?.data ?? { outputs: [] });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appTemplateId, projectId]);

  /** Forward a remote port to localhost over the SSH tunnel + open/copy it. */
  const forward = async (value: string) => {
    const port = portOf(value);
    if (!serverId || !port) return;
    try {
      const saved = await systemApi.saveTunnel(serverId, { remotePort: port });
      const started = await systemApi.startTunnel(serverId, saved.id);
      const url = started.url ?? (started.localPort ? `http://localhost:${started.localPort}` : null);
      if (url && value.startsWith("http")) window.open(url, "_blank", "noopener");
      else if (url) await navigator.clipboard.writeText(url).catch(() => {});
    } catch {
      showToast("Could not open the tunnel to localhost.", "error");
    }
  };

  // Nothing to show for non-apps or apps without a declared connection.
  if (!appTemplateId) return null;
  if (!loading && (!view || view.outputs.length === 0)) return null;

  const injectable = (view?.outputs ?? []).filter((o) => o.value);

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link2 className="size-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">{view?.title ?? "Connection"}</h3>
        </div>
        {injectable.length > 0 && (
          <button
            type="button"
            onClick={() => setLinkOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/50 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <PlugZap className="size-3.5" /> {t.projects.connections.useInProject}
          </button>
        )}
      </div>
      {view?.description && (
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">{view.description}</p>
      )}
      <div className="space-y-3">
        {(view?.outputs ?? []).map((o) => (
          <OutputRow
            key={o.id}
            output={o}
            value={o.value}
            loading={loading}
            onForward={canForward && portOf(o.value) ? () => forward(o.value) : undefined}
          />
        ))}
      </div>

      {linkOpen && (
        <UseInProjectModal
          open={linkOpen}
          onClose={() => setLinkOpen(false)}
          sourceProjectId={projectId}
          sourceAppTemplateId={appTemplateId}
          outputs={injectable}
        />
      )}
    </div>
  );
}

function OutputRow({
  output,
  value,
  loading,
  onForward,
}: {
  output: AppConnectionOutput;
  value: string;
  loading: boolean;
  onForward?: () => void | Promise<void>;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [forwarding, setForwarding] = useState(false);
  const masked = !!output.secret && !revealed;

  const copy = async () => {
    if (!value) return;
    await navigator.clipboard.writeText(value).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const doForward = async () => {
    if (!onForward) return;
    setForwarding(true);
    try {
      await onForward();
    } finally {
      setForwarding(false);
    }
  };

  return (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {output.label}
      </label>
      <div className="mt-1 flex items-center gap-1 rounded-xl border border-border/50 bg-background px-3 py-2">
        {loading ? (
          <span className="flex flex-1 items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
          </span>
        ) : value ? (
          <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
            {masked ? "•".repeat(Math.min(value.length, 40)) : value}
          </code>
        ) : (
          <span className="min-w-0 flex-1 text-[13px] text-muted-foreground/50">—</span>
        )}
        {output.secret && value && (
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={revealed ? "Hide" : "Reveal"}
          >
            {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        )}
        {onForward && value && (
          <button
            type="button"
            onClick={doForward}
            disabled={forwarding}
            className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            aria-label="Open on localhost"
            title="Open on localhost (forward the port)"
          >
            {forwarding ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <MonitorSmartphone className="size-3.5" />
            )}
          </button>
        )}
        {value && (
          <button
            type="button"
            onClick={copy}
            className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Copy"
          >
            {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          </button>
        )}
      </div>
      {output.help && <p className="mt-1 text-[11px] text-muted-foreground/70">{output.help}</p>}
    </div>
  );
}
