"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, X, Network, Globe } from "lucide-react";
import { projectsApi } from "@/lib/api";
import { connectionsApi, type ConnectionMode } from "@/lib/api/connections";
import { getApiErrorMessage } from "@/lib/api/client";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import type { AppConnectionOutput } from "@/lib/api/apps";

/** Derive a sensible env var name from the source app + chosen output. */
function defaultEnvKey(appTemplateId: string | null | undefined, outputId: string): string {
  if (appTemplateId === "mongodb") return "MONGODB_URI";
  if (outputId.toLowerCase().includes("db") || outputId.toLowerCase().includes("url"))
    return "DATABASE_URL";
  return outputId.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
}

/**
 * "Use in a project" — wire this database app into another project. Injects the
 * chosen connection value as a secret env var on the target; Internal mode joins
 * the target to this app's private network (no public port), Public uses the
 * published host:port. Applies on the target's next deploy.
 */
export function UseInProjectModal({
  open,
  onClose,
  sourceProjectId,
  sourceAppTemplateId,
  outputs,
}: {
  open: boolean;
  onClose: () => void;
  sourceProjectId: string;
  sourceAppTemplateId: string | null | undefined;
  outputs: AppConnectionOutput[];
}) {
  const { t } = useI18n();
  const c = t.projects.connections;
  const { showToast } = useToast();

  // Only outputs that carry a value can be injected (URLs / keys, not "—").
  const injectable = useMemo(() => outputs.filter((o) => o.value), [outputs]);
  const defaultOutput =
    injectable.find((o) => o.id === "dbUrl") ?? injectable.find((o) => /url/i.test(o.id)) ?? injectable[0];

  const [targets, setTargets] = useState<Array<{ id: string; name: string }>>([]);
  const [targetId, setTargetId] = useState("");
  const [outputId, setOutputId] = useState(defaultOutput?.id ?? "");
  const [mode, setMode] = useState<ConnectionMode>("internal");
  const [envKey, setEnvKey] = useState(defaultEnvKey(sourceAppTemplateId, defaultOutput?.id ?? ""));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    projectsApi
      .getHome()
      .then((res) => {
        const list = (res?.projects ?? [])
          .filter((p: { id?: string }) => p.id && p.id !== sourceProjectId)
          .map((p: { id: string; name?: string }) => ({ id: p.id, name: p.name ?? p.id }));
        setTargets(list);
      })
      .catch(() => setTargets([]));
  }, [open, sourceProjectId]);

  // Keep the env-key default in step with the chosen output (until edited).
  useEffect(() => {
    setEnvKey(defaultEnvKey(sourceAppTemplateId, outputId));
  }, [outputId, sourceAppTemplateId]);

  if (!open) return null;

  const submit = async () => {
    if (!targetId || !outputId || !envKey.trim() || busy) return;
    setBusy(true);
    try {
      await connectionsApi.create(targetId, {
        sourceProjectId,
        outputId,
        envKey: envKey.trim(),
        mode,
      });
      showToast(c.connected, "success");
      onClose();
    } catch (err) {
      showToast(getApiErrorMessage(err, c.failed), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border/50 bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold text-foreground">{c.title}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{c.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Target project */}
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {c.targetLabel}
            </label>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="mt-1 w-full rounded-xl border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
            >
              <option value="">{c.targetPlaceholder}</option>
              {targets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* Which value to inject */}
          {injectable.length > 1 && (
            <div>
              <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {c.valueLabel}
              </label>
              <select
                value={outputId}
                onChange={(e) => setOutputId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
              >
                {injectable.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Reach mode */}
          <div className="space-y-2">
            <ModeCard
              selected={mode === "internal"}
              onSelect={() => setMode("internal")}
              icon={<Network className="size-4" />}
              label={c.modeInternal}
              desc={c.modeInternalDesc}
            />
            <ModeCard
              selected={mode === "public"}
              onSelect={() => setMode("public")}
              icon={<Globe className="size-4" />}
              label={c.modePublic}
              desc={c.modePublicDesc}
            />
          </div>

          {/* Env var name */}
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {c.envKeyLabel}
            </label>
            <input
              value={envKey}
              onChange={(e) => setEnvKey(e.target.value)}
              spellCheck={false}
              className="mt-1 w-full rounded-xl border border-border/50 bg-background px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
            />
            <p className="mt-1 text-[11px] text-muted-foreground/70">{c.redeployHint}</p>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {c.cancel}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!targetId || !envKey.trim() || busy}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {c.connect}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeCard({
  selected,
  onSelect,
  icon,
  label,
  desc,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  label: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
        selected ? "border-primary/50 bg-primary/5" : "border-border/50 hover:bg-muted/30"
      }`}
    >
      <span className={`mt-0.5 ${selected ? "text-primary" : "text-muted-foreground"}`}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{desc}</span>
      </span>
    </button>
  );
}
