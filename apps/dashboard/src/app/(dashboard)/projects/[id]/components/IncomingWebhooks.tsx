"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Copy, Check, RefreshCw, Trash2, Webhook, Eye, EyeOff } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { CustomSelect } from "@/components/ui/CustomSelect";
import {
  incomingWebhooksApi,
  type IncomingWebhook,
  type IncomingWebhookActionType,
  type IncomingWebhookAuthMode,
} from "@/lib/api/incoming-webhooks";
import { servicesApi } from "@/lib/api/services";
import { jobsApi } from "@/lib/api/jobs";
import { getApiErrorMessage } from "@/lib/api/client";
import { useToast } from "@/context/ToastContext";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { WebhookDeliveries } from "./WebhookDeliveries";

export function IncomingWebhooks() {
  const { t } = useI18n();
  const c = t.projects.incomingWebhooks;
  const { showToast } = useToast();
  const { projectData } = useProjectSettings();
  const projectId = projectData.id;
  const isCloud = projectData.deployTarget === "cloud";

  const [hooks, setHooks] = useState<IncomingWebhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await incomingWebhooksApi.list(projectId);
      setHooks(res?.data ?? []);
    } catch {
      setHooks([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (hook: IncomingWebhook) => {
    if (!window.confirm(interpolate(c.deleteConfirm, { name: hook.name }))) return;
    try {
      await incomingWebhooksApi.remove(projectId, hook.id);
      setHooks((prev) => prev.filter((h) => h.id !== hook.id));
      showToast(c.removed, "success");
    } catch (err) {
      showToast(getApiErrorMessage(err, c.failed), "error");
    }
  };

  const rotate = async (hook: IncomingWebhook) => {
    try {
      const res = await incomingWebhooksApi.rotate(projectId, hook.id);
      setHooks((prev) => prev.map((h) => (h.id === hook.id ? res.data : h)));
      showToast(c.rotated, "success");
    } catch (err) {
      showToast(getApiErrorMessage(err, c.failed), "error");
    }
  };

  const toggle = async (hook: IncomingWebhook) => {
    try {
      const res = await incomingWebhooksApi.update(projectId, hook.id, { enabled: !hook.enabled });
      setHooks((prev) => prev.map((h) => (h.id === hook.id ? res.data : h)));
    } catch (err) {
      showToast(getApiErrorMessage(err, c.failed), "error");
    }
  };

  return (
    <div className="space-y-5">
      {/* GitHub push→deploy lives on the Source tab now (a single switch next to
          the repo). This tab is only the generic incoming webhooks. */}
      <div className="rounded-2xl border border-border/50 bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Webhook className="size-[18px]" />
            </div>
            <div>
              <h2 className="text-[15px] font-semibold text-foreground">{c.title}</h2>
              <p className="text-xs text-muted-foreground">{c.subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-foreground px-3 py-2 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90"
          >
            <Plus className="size-4" /> {c.create}
          </button>
        </div>

        <div className="mt-4">
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> {c.loading}
            </div>
          ) : hooks.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/50 px-4 py-6 text-center text-sm text-muted-foreground">
              {c.empty}
            </p>
          ) : (
            <ul className="space-y-2.5">
              {hooks.map((hook) => (
                <HookRow
                  key={hook.id}
                  hook={hook}
                  onRotate={() => rotate(hook)}
                  onDelete={() => remove(hook)}
                  onToggle={() => toggle(hook)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Delivery feed — every inbound webhook for this project, paginated. */}
      <WebhookDeliveries
        fetchPage={(cursor) => incomingWebhooksApi.deliveries(projectId, { cursor }).then((r) => r.data)}
        subtitle="GitHub pushes and custom hook calls received for this project."
      />

      {creating && (
        <CreateHookModal
          projectId={projectId}
          isCloud={isCloud}
          onClose={() => setCreating(false)}
          onCreated={(hook) => {
            setHooks((prev) => [hook, ...prev]);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function HookRow({
  hook,
  onRotate,
  onDelete,
  onToggle,
}: {
  hook: IncomingWebhook;
  onRotate: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const c = t.projects.incomingWebhooks;
  const [showSecret, setShowSecret] = useState(false);

  const actionSummary =
    hook.actionType === "deploy"
      ? hook.actionConfig.serviceId
        ? interpolate(c.summaryDeployService, { service: hook.actionConfig.serviceId })
        : c.summaryDeploy
      : interpolate(c.summaryJob, { job: hook.actionConfig.jobKey ?? "" });

  return (
    <li className={`rounded-xl border border-border/50 p-3 ${hook.enabled ? "" : "opacity-60"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{hook.name}</span>
            <span className="rounded-md bg-muted/60 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {c.authBadge[hook.authMode]}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{actionSummary}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={hook.enabled}
            aria-label={c.toggleAria}
            onClick={onToggle}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${hook.enabled ? "bg-primary" : "bg-muted"}`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background transition-transform ${hook.enabled ? "translate-x-4 rtl:-translate-x-4" : "translate-x-1 rtl:-translate-x-1"}`}
            />
          </button>
          <IconBtn title={c.rotate} onClick={onRotate}>
            <RefreshCw className="size-3.5" />
          </IconBtn>
          <IconBtn title={c.delete} onClick={onDelete} destructive>
            <Trash2 className="size-3.5" />
          </IconBtn>
        </div>
      </div>

      <CopyField label={c.urlLabel} value={hook.url} mono />
      {hook.authMode !== "none" && hook.secret && (
        <CopyField
          label={c.secretLabel}
          value={hook.secret}
          mono
          masked={!showSecret}
          onToggleMask={() => setShowSecret((v) => !v)}
        />
      )}
    </li>
  );
}

function IconBtn({
  children,
  title,
  onClick,
  destructive,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 ${destructive ? "hover:text-danger" : "hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

function CopyField({
  label,
  value,
  mono,
  masked,
  onToggleMask,
}: {
  label: string;
  value: string;
  mono?: boolean;
  masked?: boolean;
  onToggleMask?: () => void;
}) {
  const { t } = useI18n();
  const c = t.projects.incomingWebhooks;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="mt-3">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="mt-1 flex items-center gap-1.5">
        <code
          className={`min-w-0 flex-1 truncate rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground ${mono ? "font-mono" : ""}`}
        >
          {masked ? "•".repeat(24) : value}
        </code>
        {onToggleMask && (
          <IconBtn title={masked ? c.reveal : c.hide} onClick={onToggleMask}>
            {masked ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
          </IconBtn>
        )}
        <IconBtn title={copied ? c.copied : c.copy} onClick={copy}>
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </IconBtn>
      </div>
    </div>
  );
}

// ─── Create modal ────────────────────────────────────────────────────────────

function CreateHookModal({
  projectId,
  isCloud,
  onClose,
  onCreated,
}: {
  projectId: string;
  isCloud?: boolean;
  onClose: () => void;
  onCreated: (hook: IncomingWebhook) => void;
}) {
  const { t } = useI18n();
  const c = t.projects.incomingWebhooks;
  const { showToast } = useToast();

  const [name, setName] = useState("");
  const [actionType, setActionType] = useState<IncomingWebhookActionType>("deploy");
  const [serviceId, setServiceId] = useState("");
  const [jobKey, setJobKey] = useState("");
  const [authMode, setAuthMode] = useState<IncomingWebhookAuthMode>("token");
  const [busy, setBusy] = useState(false);

  const [services, setServices] = useState<Array<{ id: string; name: string }>>([]);
  const [jobs, setJobs] = useState<Array<{ key: string; label: string }>>([]);

  useEffect(() => {
    servicesApi
      .list(projectId)
      .then((r) => setServices((r?.services ?? []).map((s) => ({ id: s.id, name: s.name }))))
      .catch(() => setServices([]));
    jobsApi
      .list()
      .then((r) => setJobs((r?.data ?? []).map((j) => ({ key: j.key, label: j.label }))))
      .catch(() => setJobs([]));
  }, [projectId]);

  const canSubmit = name.trim() && (actionType !== "job" || jobKey) && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const res = await incomingWebhooksApi.create(projectId, {
        name: name.trim(),
        actionType,
        actionConfig: actionType === "deploy" ? { serviceId: serviceId || undefined } : { jobKey },
        authMode,
      });
      showToast(c.created, "success");
      onCreated(res.data);
    } catch (err) {
      showToast(getApiErrorMessage(err, c.failed), "error");
    } finally {
      setBusy(false);
    }
  };

  const actionOptions = useMemo(
    () => [
      { value: "deploy", label: c.actionDeploy, description: c.actionDeployDesc },
      // Jobs are a self-hosted control-plane feature — refused server-side in
      // CLOUD_MODE, so don't offer the option on a cloud project.
      ...(isCloud ? [] : [{ value: "job", label: c.actionJob, description: c.actionJobDesc }]),
    ],
    [c, isCloud],
  );
  const authOptions = useMemo(
    () => [
      { value: "token", label: c.authToken, description: c.authTokenDesc },
      { value: "hmac", label: c.authHmac, description: c.authHmacDesc },
      { value: "none", label: c.authNone, description: c.authNoneDesc },
    ],
    [c],
  );

  return (
    <Modal isOpen onClose={onClose} width="480px" maxWidth="95vw" showCloseButton>
      <div className="p-6">
        <h3 className="text-base font-semibold text-foreground">{c.createTitle}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{c.createSubtitle}</p>

        <div className="mt-4 space-y-4">
          <Field label={c.nameLabel}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={c.namePlaceholder}
              className="w-full rounded-xl border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
            />
          </Field>

          <Field label={c.actionLabel}>
            <CustomSelect
              value={actionType}
              options={actionOptions}
              onChange={(v) => setActionType(v as IncomingWebhookActionType)}
            />
          </Field>

          {actionType === "deploy" ? (
            <Field label={c.serviceLabel}>
              <CustomSelect
                value={serviceId}
                options={[
                  { value: "", label: c.serviceAll },
                  ...services.map((s) => ({ value: s.id, label: s.name })),
                ]}
                onChange={setServiceId}
              />
            </Field>
          ) : (
            <Field label={c.jobLabel}>
              <CustomSelect
                value={jobKey}
                options={jobs.map((j) => ({ value: j.key, label: j.label }))}
                onChange={setJobKey}
                placeholder={c.jobPlaceholder}
              />
            </Field>
          )}

          <Field label={c.authLabel}>
            <CustomSelect
              value={authMode}
              options={authOptions}
              onChange={(v) => setAuthMode(v as IncomingWebhookAuthMode)}
            />
          </Field>
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
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {c.create}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
