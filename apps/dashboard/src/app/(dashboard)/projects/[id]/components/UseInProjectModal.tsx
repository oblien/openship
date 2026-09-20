"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Network, Globe, Copy, Check, ChevronDown } from "lucide-react";
import { resolveLocalized } from "@repo/core";
import { Modal } from "@/components/ui/Modal";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Checkbox } from "@/components/ui/Checkbox";
import { AppLogo } from "@/components/AppLogo";
import { connectionsApi, type ConnectionMode } from "@/lib/api/connections";
import { getApiErrorMessage } from "@/lib/api/client";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { appsApi, type AppConnectionOutput, type AppConnectionGuide, type AppConnectionView } from "@/lib/api/apps";

/** Fallback env-var name when a catalog output doesn't declare one. Derived
 *  PER OUTPUT (camelCase → SNAKE_CASE) so distinct values get distinct keys —
 *  never a blanket single name for every output. Catalog `envKey` wins over this. */
function defaultEnvKey(_appTemplateId: string | null | undefined, outputId: string): string {
  const id = outputId.toLowerCase();
  if (id === "dburl" || id === "url" || id === "uri" || (id.includes("db") && (id.includes("url") || id.includes("uri"))))
    return "DATABASE_URL";
  return outputId
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toUpperCase();
}

/** Render a hint string, wrapping `backtick` segments as inline <code> so
 *  authored guides feel native (markdown-style inline code). */
function InlineHint({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((seg, i) =>
        i % 2 === 1 ? (
          <code
            key={i}
            className="rounded bg-foreground/[0.08] px-1 py-0.5 font-mono text-[12px] text-foreground"
          >
            {seg}
          </code>
        ) : (
          <span key={i}>{seg}</span>
        ),
      )}
    </>
  );
}

interface TargetProject {
  id: string;
  name: string;
  description: string;
  appTemplateId?: string;
  favicon?: string | null;
}

interface ConnectionFormProps {
  onClose: () => void;
  hideHeader?: boolean;
  sourceProjectId?: string;
  sourceServiceId?: string;
  sourceAppTemplateId?: string | null;
  outputs?: AppConnectionOutput[];
  guide?: AppConnectionGuide;
  targetProjectId?: string;
}

/** Both entry points share this form: share a service, or connect an existing one. */
export function UseInProjectModal({ open, ...props }: ConnectionFormProps & { open: boolean }) {
  return (
    <Modal isOpen={open} onClose={props.onClose} width="1040px" maxWidth="95vw" showCloseButton>
      {open && <ProjectConnectionForm {...props} />}
    </Modal>
  );
}

export function ProjectConnectionForm({
  onClose,
  hideHeader = false,
  sourceProjectId: fixedSourceId,
  sourceServiceId,
  sourceAppTemplateId: fixedTemplateId,
  outputs: suppliedOutputs,
  guide: suppliedGuide,
  targetProjectId: fixedTargetId,
}: ConnectionFormProps) {
  const { t, locale } = useI18n();
  const c = t.projects.connections;
  const { showToast } = useToast();
  const [sourceProjectId, setSourceProjectId] = useState(fixedSourceId ?? "");
  const [loaded, setLoaded] = useState<{ id: string; view: AppConnectionView } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const view = loaded?.id === sourceProjectId ? loaded.view : null;
  const guide = suppliedGuide ?? view?.guide;
  const injectable = useMemo(() => (suppliedOutputs ?? view?.outputs ?? []).filter(
    output => output.value && (!sourceServiceId || output.sourceServiceId === sourceServiceId),
  ), [suppliedOutputs, view, sourceServiceId]);

  const [targets, setTargets] = useState<TargetProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [targetId, setTargetId] = useState(fixedTargetId ?? "");
  const [mode, setMode] = useState<ConnectionMode>(guide?.defaultMode ?? "internal");
  const [rows, setRows] = useState<Record<string, { checked: boolean; envKey: string }>>({});
  const [advanced, setAdvanced] = useState(true);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const sourceAppTemplateId = fixedTemplateId ?? targets.find(project => project.id === sourceProjectId)?.appTemplateId;

  useEffect(() => {
    if (suppliedOutputs || !sourceProjectId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    appsApi.getConnection(sourceProjectId).then(result => {
      if (!cancelled) setLoaded({ id: sourceProjectId, view: result.data });
    }).catch(error => {
      if (!cancelled) setLoadError(getApiErrorMessage(error, c.failed));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sourceProjectId, suppliedOutputs, c.failed]);

  // The recommended env key to reference in code — catalog `recommended` output
  // first, else the primary URL. Drives the "read process.env.X" hint.
  const primaryEnvKey = useMemo(() => {
    const rec = injectable.find((o) => o.recommended);
    const primary =
      rec ??
      injectable.find((o) => o.id === "dbUrl") ??
      injectable.find((o) => /url/i.test(o.id)) ??
      injectable[0];
    return primary ? (primary.envKey ?? defaultEnvKey(sourceAppTemplateId, primary.id)) : "";
  }, [injectable, sourceAppTemplateId]);

  // Seed the checklist: catalog-recommended outputs pre-checked (fall back to the
  // primary URL if none flagged); each env name from the catalog (fallback derived).
  useEffect(() => {
    const hasRecommended = injectable.some((o) => o.recommended);
    const fallbackPrimary =
      injectable.find((o) => o.id === "dbUrl")?.id ??
      injectable.find((o) => /url/i.test(o.id))?.id ??
      injectable[0]?.id;
    const seeded: Record<string, { checked: boolean; envKey: string }> = {};
    for (const o of injectable) {
      seeded[o.id] = {
        checked: hasRecommended ? !!o.recommended : o.id === fallbackPrimary,
        envKey: o.envKey ?? defaultEnvKey(sourceAppTemplateId, o.id),
      };
    }
    setRows(seeded);
    setMode(guide?.defaultMode ?? "internal");
    setAdvanced(true);
  }, [injectable, sourceAppTemplateId, guide?.defaultMode]);

  useEffect(() => {
    let cancelled = false;
    setLoadingProjects(true);
    connectionsApi.candidates(fixedSourceId ?? fixedTargetId ?? "")
      .then(result => {
        if (!cancelled) setTargets(result.data.map(project => ({ ...project, appTemplateId: project.appTemplateId ?? undefined })));
      })
      .catch(error => { if (!cancelled) setLoadError(getApiErrorMessage(error, c.failed)); })
      .finally(() => { if (!cancelled) setLoadingProjects(false); });
    return () => { cancelled = true; };
  }, [fixedSourceId, fixedTargetId, c.failed]);

  const selected = injectable.filter((o) => rows[o.id]?.checked && rows[o.id]?.envKey.trim());
  const privateOnly = selected.some(output => output.internal);
  useEffect(() => { if (privateOnly) setMode("internal"); }, [privateOnly]);
  const intro = resolveLocalized(guide?.intro, locale) || c.guideIntroFallback;
  const useHint = resolveLocalized(guide?.useHint, locale);
  // Bare env-var name — language-agnostic. NOT `process.env.X` (JS-only): every
  // runtime reads env vars by name, so show the name the app should read.
  const usageCode = selected.length ? rows[selected[0].id]?.envKey : primaryEnvKey;

  const copyUsage = async () => {
    if (!usageCode) return;
    await navigator.clipboard.writeText(usageCode).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const submit = async () => {
    if (!sourceProjectId || !targetId || selected.length === 0 || busy) return;
    setBusy(true);
    try {
      await connectionsApi.bundle(targetId, {
        sourceProjectId,
        items: selected.map(output => ({ outputId: output.id, envKey: rows[output.id].envKey.trim() })),
        mode,
      });
      const targetName = targets.find(project => project.id === targetId)?.name;
      showToast(targetName
        ? interpolate(c.connectedN, { count: String(selected.length), project: targetName })
        : c.connected, "success");
      onClose();
    } catch (error) {
      showToast(getApiErrorMessage(error, c.failed), "error");
    } finally { setBusy(false); }
  };

  return (
      <div className="p-6">
        {!hideHeader && <div className="mb-5">
          <h3 className="text-base font-semibold text-foreground">{fixedTargetId ? c.connectExisting : c.title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{fixedTargetId ? c.existingHint : c.subtitle}</p>
        </div>}

        <div className="grid gap-5 md:grid-cols-[1.5fr_1fr]">
          {/* ── Left: target + values grid ─────────────────────────────── */}
          <div className="space-y-4">
            <div>
              <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {fixedTargetId ? c.sourceLabel : c.targetLabel}
              </label>
              <div className="mt-1.5">
                <CustomSelect
                  searchPlaceholder={t.dashboard.pages.projects.searchPlaceholder}
                  emptySearchMessage={query => interpolate(t.dashboard.pages.projects.noResultsFound, { query })}
                  value={fixedTargetId ? sourceProjectId : targetId}
                  options={targets.map((p) => ({
                    value: p.id,
                    label: p.name,
                    description: p.description || undefined,
                    icon: (
                      <AppLogo appId={p.appTemplateId} src={p.favicon ?? undefined} className="size-4" />
                    ),
                  }))}
                  onChange={fixedTargetId ? setSourceProjectId : setTargetId}
                  disabled={loadingProjects || busy}
                  placeholder={fixedTargetId ? c.sourcePlaceholder : c.targetPlaceholder}
                />
              </div>
            </div>

            {loadError && <p role="alert" className="text-sm text-danger">{loadError}</p>}
            {(loading || loadingProjects) && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{c.loadingServices}</div>}
            {!loading && !loadError && sourceProjectId && injectable.length === 0 && (
              <p className="rounded-xl border border-border/50 p-4 text-sm text-muted-foreground">{c.noConnections}</p>
            )}
            {!loadingProjects && !loading && targets.length === 0 && !loadError && (
              <p className="text-sm text-muted-foreground">{c.noSources}</p>
            )}
            <div>
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {c.valuesLabel}
                </label>
                <button
                  type="button"
                  onClick={() => setAdvanced((v) => !v)}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground/80 transition-colors hover:text-foreground"
                >
                  <ChevronDown className={`size-3 transition-transform ${advanced ? "rotate-180" : ""}`} />
                  {c.advancedValues}
                </button>
              </div>
              <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {injectable.map((o) => {
                  const row = rows[o.id] ?? { checked: false, envKey: "" };
                  return (
                    // The whole card is the hit target — click anywhere to
                    // toggle. The env chip below stops propagation so copying /
                    // editing it doesn't flip the selection.
                    // Mouse click-anywhere convenience; the Checkbox inside is
                    // the real keyboard-accessible control (avoids a nested
                    // button-in-button / double tab stop).
                    <div
                      key={o.id}
                      onClick={() => setRows((prev) => ({ ...prev, [o.id]: { ...row, checked: !row.checked } }))}
                      className={`cursor-pointer rounded-xl border p-3 text-start transition-colors ${
                        row.checked
                          ? "border-primary/50 bg-primary/[0.05]"
                          : "border-border/50 hover:border-border/80 hover:bg-muted/30"
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <Checkbox
                          checked={row.checked}
                          onClick={(e) => e.stopPropagation()}
                          onCheckedChange={(checked) =>
                            setRows((prev) => ({ ...prev, [o.id]: { ...row, checked } }))
                          }
                          aria-label={o.label}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={o.label}>
                          {o.label}
                        </span>
                      </div>
                      <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                        <EnvKeyField
                          value={row.envKey}
                          editable={advanced}
                          copyLabel={c.copy}
                          onChange={(v) =>
                            setRows((prev) => ({ ...prev, [o.id]: { ...row, envKey: v } }))
                          }
                          onActivate={() =>
                            !row.checked &&
                            setRows((prev) => ({ ...prev, [o.id]: { ...row, checked: true } }))
                          }
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ── Right rail: guide + reach mode + action ────────────────── */}
          <div className="flex flex-col gap-4 rounded-2xl border border-border/40 bg-muted/20 p-4">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {c.whatYouGet}
              </p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-foreground">{intro}</p>
              {usageCode && (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-background px-2.5 py-1.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                    {usageCode}
                  </code>
                  <button
                    type="button"
                    onClick={copyUsage}
                    aria-label={c.copy}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
                  </button>
                </div>
              )}
              {useHint && (
                <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                  <InlineHint text={useHint} />
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <ModeCard
                selected={mode === "internal"}
                onSelect={() => setMode("internal")}
                icon={<Network className="size-4" />}
                label={c.modeInternal}
                desc={c.modeInternalDesc}
              />
              {!privateOnly && <ModeCard
                selected={mode === "public"}
                onSelect={() => setMode("public")}
                icon={<Globe className="size-4" />}
                label={c.modePublic}
                desc={c.modePublicDesc}
              />}
            </div>

            <div className="mt-auto space-y-2">
              <p className="text-[11px] text-muted-foreground/70">{c.redeployHint}</p>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
                >
                  {c.cancel}
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={!sourceProjectId || !targetId || selected.length === 0 || busy || loading}
                  className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  {c.connect}
                </button>
              </div>
            </div>
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
        selected ? "border-primary/50 bg-primary/5" : "border-border/50 bg-background hover:bg-muted/30"
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

/**
 * The env-var name a value injects as. Copy-only by default (it's derived from
 * the source and most consumers keep it as-is); editable only under the
 * "Advanced" disclosure for apps that expect a different variable name.
 */
function EnvKeyField({
  value,
  editable,
  copyLabel,
  onChange,
  onActivate,
}: {
  value: string;
  editable: boolean;
  copyLabel: string;
  onChange: (value: string) => void;
  onActivate: () => void;
}) {
  const [copied, setCopied] = useState(false);

  if (editable) {
    return (
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onActivate}
        spellCheck={false}
        placeholder="ENV_VAR"
        className="w-full rounded-lg border border-border/50 bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
      />
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-muted/40 px-2 py-1">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{value}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={copyLabel}
        className="shrink-0 text-muted-foreground/60 transition-colors hover:text-foreground"
      >
        {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      </button>
    </div>
  );
}
