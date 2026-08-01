"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Cloud, HardDrive, Loader2, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import {
  getApiErrorMessage,
  projectsApi,
  type BindObjectStorageBody,
  type ObjectStorageView,
} from "@/lib/api";

/**
 * Project → Configuration → storage.
 *
 * Unlike the rest of the Configuration tab this card is editable in place. The
 * read-only-plus-wizard rule exists so build config always ships as a new
 * version; storage is the opposite kind of setting — you reach for it BECAUSE a
 * deploy just threw data away, and routing that through a full re-deploy wizard
 * is the wrong shape for "keep this directory".
 *
 * Two states matter and are visually distinct: INHERITED (the framework's own
 * defaults, e.g. Laravel's `storage/`) versus DECLARED (the user's list, which
 * may deliberately be empty). Showing an inherited value in an empty-looking
 * field would read as "nothing is persisted".
 */

const ICON_TONES = {
  primary: "bg-primary/10 text-primary",
  amber: "bg-warning-bg text-warning",
  emerald: "bg-success-bg text-success",
  muted: "bg-muted/60 text-muted-foreground",
} as const;

function SectionCard({
  title,
  description,
  icon: Icon,
  iconTone,
  actions,
  children,
}: {
  title: string;
  description?: string;
  icon: React.ComponentType<{ className?: string }>;
  iconTone: keyof typeof ICON_TONES;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${ICON_TONES[iconTone]}`}
        >
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
          {description && <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

/** One mount per line — the same list-in-a-textarea shape the service editor
 *  uses for its volumes, so the two don't need different mental models. */
function splitLines(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function StorageSettings(): React.JSX.Element {
  return (
    <>
      <PersistentPathsCard />
      <ObjectStorageCard />
    </>
  );
}

function PersistentPathsCard(): React.JSX.Element {
  const { id, buildData, updateBuild } = useProjectSettings();
  const { t } = useI18n();
  const { showToast } = useToast();
  const s = t.projectSettings.build.storage;

  const declared = buildData.volumes;
  const resolved = buildData.resolvedVolumes ?? [];
  const inherited = declared === null || declared === undefined;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // Re-seed whenever the server value changes (a save, or a tab revisit) so the
  // draft never shows a stale list after someone else edited the project.
  useEffect(() => {
    setDraft(resolved.join("\n"));
  }, [resolved.join("\n")]);

  const shown = useMemo(() => resolved, [resolved]);

  const save = async (volumes: string[] | null) => {
    setSaving(true);
    try {
      await projectsApi.setOptions(id, { volumes });
      // Read back rather than echo the draft: the server normalizes bare paths
      // into real mounts, and on a reset only it knows what the framework
      // default resolves to.
      const fresh = await projectsApi.getObjectStorage(id).catch(() => null);
      updateBuild({
        volumes: fresh?.data?.volumes ?? volumes,
        resolvedVolumes: fresh?.data?.resolvedVolumes ?? volumes ?? [],
      });
      setEditing(false);
      showToast(s.saved, "success");
    } catch (err) {
      showToast(getApiErrorMessage(err), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      icon={HardDrive}
      iconTone="amber"
      title={s.title}
      description={s.description}
      actions={
        editing ? null : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
          >
            <Pencil className="size-3.5" />
            {s.edit}
          </button>
        )
      }
    >
      {editing ? (
        <div className="space-y-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            spellCheck={false}
            placeholder={s.placeholder}
            className="w-full rounded-xl border border-border/60 bg-background px-3 py-2 font-mono text-[12px] text-foreground outline-none focus:border-primary/60"
          />
          <p className="text-[12px] text-muted-foreground">{s.hint}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void save(splitLines(draft))}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {s.save}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setDraft(resolved.join("\n"));
                setEditing(false);
              }}
              className="rounded-xl border border-border/60 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
            >
              {s.cancel}
            </button>
            {!inherited && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void save(null)}
                className="ml-auto inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <RotateCcw className="size-3.5" />
                {s.reset}
              </button>
            )}
          </div>
        </div>
      ) : shown.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{s.empty}</p>
      ) : (
        <div className="space-y-2">
          <ul className="overflow-hidden rounded-xl border border-border/40 divide-y divide-border/30">
            {shown.map((mount) => (
              <li key={mount} className="px-3 py-2 font-mono text-[12px] text-foreground">
                {mount}
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-muted-foreground">
            {inherited ? s.inherited : s.declared}
          </p>
        </div>
      )}
    </SectionCard>
  );
}

/**
 * Object storage — the scaling answer to the same problem the card above solves
 * locally. A local volume stops data loss on redeploy but breaks the moment there
 * is more than one replica (two containers, two upload directories); a bucket
 * doesn't.
 *
 * The two sources are deliberately one form: picking an installed MinIO app fills
 * in its endpoint and keys server-side, so the only thing left to type is the
 * bucket. Everything is verified against the real bucket before any env is
 * written — a bind that "succeeded" against a nonexistent bucket would surface as
 * a 500 on the user's first upload instead.
 */
function ObjectStorageCard(): React.JSX.Element {
  const { id } = useProjectSettings();
  const { t } = useI18n();
  const { showToast } = useToast();
  const s = t.projectSettings.build.objectStorage;

  const [view, setView] = useState<ObjectStorageView | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // "" = an external provider is being configured; otherwise a source project id.
  const [source, setSource] = useState("");
  const [provider, setProvider] = useState("aws");
  const [bucket, setBucket] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await projectsApi.getObjectStorage(id);
      setView(res.data ?? null);
    } catch {
      // A read failure leaves the card in its empty state; the bind attempt will
      // surface the real error with a message worth showing.
      setView(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const providerSpec = view?.providers?.[provider];
  const candidates = view?.candidates ?? [];

  // Seed region/bucket from whatever was just picked, so the common path is
  // "choose, then Connect".
  useEffect(() => {
    if (source) {
      const picked = candidates.find((c) => c.projectId === source);
      if (picked?.defaultBucket) setBucket(picked.defaultBucket);
      return;
    }
    if (providerSpec) setRegion(providerSpec.defaultRegion);
  }, [source, provider, providerSpec?.defaultRegion, candidates.length]);

  const bind = async () => {
    setBusy(true);
    try {
      const body: BindObjectStorageBody = source
        ? { bucket: bucket.trim(), sourceProjectId: source }
        : {
            bucket: bucket.trim(),
            provider,
            endpoint: endpoint.trim() || undefined,
            region: region.trim() || undefined,
            accessKeyId: accessKeyId.trim(),
            secretAccessKey: secretAccessKey.trim(),
          };
      await projectsApi.bindObjectStorage(id, body);
      setOpen(false);
      setAccessKeyId("");
      setSecretAccessKey("");
      await load();
      showToast(s.connected, "success");
    } catch (err) {
      showToast(getApiErrorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const unbind = async () => {
    setBusy(true);
    try {
      await projectsApi.unbindObjectStorage(id);
      await load();
      showToast(s.disconnected, "success");
    } catch (err) {
      showToast(getApiErrorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const binding = view?.binding ?? null;

  return (
    <SectionCard
      icon={Cloud}
      iconTone="primary"
      title={s.title}
      description={s.description}
      actions={
        loading || open ? null : binding ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void unbind()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            {s.disconnect}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {s.connect}
          </button>
        )
      }
    >
      {loading ? (
        <p className="text-[13px] text-muted-foreground">
          <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
          {s.loading}
        </p>
      ) : open ? (
        <div className="space-y-3">
          <label className="block">
            <span className="text-[12px] font-medium text-foreground">{s.sourceLabel}</span>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="mt-1 w-full rounded-xl border border-border/60 bg-background px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary/60"
            >
              <option value="">{s.externalOption}</option>
              {candidates.map((c) => (
                <option key={c.projectId} value={c.projectId}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          {!source && (
            <>
              <label className="block">
                <span className="text-[12px] font-medium text-foreground">{s.providerLabel}</span>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-border/60 bg-background px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary/60"
                >
                  {Object.values(view?.providers ?? {}).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              {providerSpec?.endpointPlaceholder ? (
                <Field
                  label={s.endpointLabel}
                  value={endpoint}
                  onChange={setEndpoint}
                  placeholder={providerSpec.endpointPlaceholder}
                  mono
                />
              ) : null}
              <Field label={s.regionLabel} value={region} onChange={setRegion} mono />
              <Field label={s.accessKeyLabel} value={accessKeyId} onChange={setAccessKeyId} mono />
              <Field
                label={s.secretKeyLabel}
                value={secretAccessKey}
                onChange={setSecretAccessKey}
                type="password"
                mono
              />
            </>
          )}

          <Field label={s.bucketLabel} value={bucket} onChange={setBucket} mono />

          <p className="text-[12px] text-muted-foreground">
            {s.envHint} <span className="font-mono">{(view?.envKeys ?? []).join(", ")}</span>
          </p>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !bucket.trim()}
              onClick={() => void bind()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {s.testAndConnect}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setOpen(false)}
              className="rounded-xl border border-border/60 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
            >
              {s.cancel}
            </button>
          </div>
        </div>
      ) : binding ? (
        <div className="space-y-2">
          <div className="overflow-hidden rounded-xl border border-border/40 divide-y divide-border/30 text-[12px]">
            <Row label={s.bucketLabel} value={binding.bucket} />
            <Row
              label={s.providerLabel}
              value={view?.providers?.[binding.provider]?.label ?? binding.provider}
            />
            {binding.endpoint ? <Row label={s.endpointLabel} value={binding.endpoint} /> : null}
            <Row label={s.envLabel} value={binding.envKeys.join(", ")} />
          </div>
          <p className="text-[12px] text-muted-foreground">{s.appliesOnDeploy}</p>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">{s.empty}</p>
      )}
    </SectionCard>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="text-[12px] font-medium text-foreground">{label}</span>
      <input
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={`mt-1 w-full rounded-xl border border-border/60 bg-background px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary/60 ${mono ? "font-mono" : ""}`}
      />
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 px-3 py-2">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-foreground">{value}</span>
    </div>
  );
}
