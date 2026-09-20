"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Github,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Star,
  Trash2,
} from "lucide-react";

import { useI18n } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { authClient, useSession } from "@/lib/auth-client";
import {
  getApiErrorMessage,
  GITHUB_SOURCES_CHANGED_EVENT,
  githubApi,
  type GitHubSource,
  type GitHubSourceConfiguration,
  type ManualGitHubSourceInput,
  type UpdateGitHubSourceInput,
} from "@/lib/api";
import { SettingsSection } from "./SettingsSection";

const orgClient = (
  authClient as unknown as {
    organization: {
      listMembers: () => Promise<{ data?: { members?: Array<{ userId: string; role: string }> } }>;
    };
  }
).organization;

const DEFAULT_API = "https://api.github.com";
const DEFAULT_WEB = "https://github.com";

function openPendingWindow(name: string): Window | null {
  return window.open("", name, "popup,width=720,height=820");
}

function navigateWindow(popup: Window | null, url: string): void {
  if (popup && !popup.closed) popup.location.replace(url);
  else window.location.assign(url);
}

export function GitHubSources() {
  const { data: session } = useSession();
  const { t } = useI18n();
  const copy = t.settings.githubSources;
  const { showToast } = useToast();
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [sources, setSources] = useState<GitHubSource[]>([]);
  const [configuration, setConfiguration] = useState<GitHubSourceConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [panel, setPanel] = useState<"manifest" | "manual" | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [manifestName, setManifestName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const pendingExternalFlow = useRef(false);

  useEffect(() => {
    let cancelled = false;
    orgClient
      .listMembers()
      .then((res) => {
        if (cancelled) return;
        const me = res.data?.members?.find((member) => member.userId === session?.user?.id);
        setIsOwner(me?.role === "owner");
      })
      .catch(() => {
        if (!cancelled) setIsOwner(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  const load = useCallback(async () => {
    if (isOwner !== true) return;
    setLoading(true);
    try {
      const response = await githubApi.listSources();
      setSources(response.data ?? []);
      setConfiguration(response.configuration);
      githubApi.invalidateStatus();
      window.dispatchEvent(new Event(GITHUB_SOURCES_CHANGED_EVENT));
    } catch (error) {
      showToast(getApiErrorMessage(error, copy.toast.loadFailed), "error");
    } finally {
      setLoading(false);
    }
  }, [copy.toast.loadFailed, isOwner, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Manifest creation and App installation finish in a separate GitHub window.
  // Refresh both settings cards when the operator returns so the newly created
  // source/installation appears without a full page reload.
  useEffect(() => {
    const refreshIfPending = () => {
      if (!pendingExternalFlow.current) return;
      pendingExternalFlow.current = false;
      void load();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshIfPending();
    };
    window.addEventListener("focus", refreshIfPending);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refreshIfPending);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  if (isOwner !== true) return null;

  const beginManifest = async () => {
    const target = `openship-github-app-${Date.now()}`;
    const popup = openPendingWindow(target);
    setBusy("manifest");
    try {
      const result = await githubApi.beginSourceManifest(manifestName);
      const form = document.createElement("form");
      form.method = "POST";
      form.action = result.url;
      form.target = popup ? target : "_self";
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "manifest";
      input.value = JSON.stringify(result.manifest);
      form.appendChild(input);
      document.body.appendChild(form);
      pendingExternalFlow.current = true;
      form.submit();
      form.remove();
      setPanel(null);
      setManifestName("");
    } catch (error) {
      popup?.close();
      showToast(getApiErrorMessage(error, copy.toast.createFailed), "error");
    } finally {
      setBusy(null);
    }
  };

  const install = async (source: GitHubSource) => {
    const popup = openPendingWindow(`openship-github-install-${source.id}`);
    setBusy(source.id);
    try {
      const result = await githubApi.createSourceInstallUrl(source.id);
      pendingExternalFlow.current = true;
      navigateWindow(popup, result.url);
    } catch (error) {
      popup?.close();
      showToast(getApiErrorMessage(error, copy.toast.installFailed), "error");
    } finally {
      setBusy(null);
    }
  };

  const verify = async (source: GitHubSource) => {
    setBusy(source.id);
    try {
      await githubApi.verifySource(source.id);
      showToast(copy.toast.verified, "success");
      await load();
    } catch (error) {
      showToast(getApiErrorMessage(error, copy.toast.verifyFailed), "error");
      await load();
    } finally {
      setBusy(null);
    }
  };

  const makeDefault = async (source: GitHubSource) => {
    setBusy(source.id);
    try {
      await githubApi.setDefaultSource(source.id);
      showToast(copy.toast.defaultChanged, "success");
      await load();
    } catch (error) {
      showToast(getApiErrorMessage(error, copy.toast.defaultFailed), "error");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (source: GitHubSource) => {
    if (!window.confirm(copy.confirmDelete.replace("{name}", source.name))) return;
    setBusy(source.id);
    try {
      await githubApi.removeSource(source.id);
      showToast(copy.toast.deleted, "success");
      if (editing === source.id) setEditing(null);
      await load();
      githubApi.invalidateStatus();
    } catch (error) {
      showToast(getApiErrorMessage(error, copy.toast.deleteFailed), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection icon={Github} title={copy.title} description={copy.description}>
      {loading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t.settings.common.loading}
        </div>
      ) : (
        <div className="space-y-4">
          {!configuration?.publicReady && (
            <div className="flex items-start gap-2 rounded-xl bg-warning/10 px-3.5 py-3 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{copy.publicUrlRequired}</span>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!configuration?.publicReady}
              onClick={() => {
                setPanel(panel === "manifest" ? null : "manifest");
                setEditing(null);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-2 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Plus className="size-3.5" /> {copy.createWithGithub}
            </button>
            <button
              type="button"
              disabled={!configuration?.publicReady}
              onClick={() => {
                setPanel(panel === "manual" ? null : "manual");
                setEditing(null);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-muted/60 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40"
            >
              {copy.registerExisting}
            </button>
          </div>

          {panel === "manifest" && (
            <div className="space-y-3 rounded-xl border border-border/50 bg-muted/20 p-4">
              <p className="text-xs leading-relaxed text-muted-foreground">{copy.manifestHelp}</p>
              <Field label={copy.nameLabel}>
                <input
                  autoFocus
                  value={manifestName}
                  maxLength={100}
                  onChange={(event) => setManifestName(event.target.value)}
                  placeholder={copy.namePlaceholder}
                  className={inputClass}
                />
              </Field>
              <FormActions
                saving={busy === "manifest"}
                disabled={!manifestName.trim()}
                saveLabel={copy.continueOnGithub}
                cancelLabel={t.settings.common.cancel}
                onSave={() => void beginManifest()}
                onCancel={() => setPanel(null)}
              />
            </div>
          )}

          {panel === "manual" && configuration && (
            <SourceForm
              configuration={configuration}
              onCancel={() => setPanel(null)}
              onSaved={async () => {
                setPanel(null);
                await load();
                githubApi.invalidateStatus();
              }}
              onExternalFlowStarted={() => {
                pendingExternalFlow.current = true;
              }}
            />
          )}

          {sources.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">{copy.empty}</p>
          ) : (
            <div className="space-y-3">
              {sources.map((source) => {
                const staleWebhook =
                  configuration && source.webhookUrl !== configuration.webhookUrl;
                return (
                  <div key={source.id} className="rounded-xl border border-border/50 p-4">
                    <div className="flex items-start gap-3">
                      {source.avatarUrl ? (
                        <img src={source.avatarUrl} alt="" className="size-9 rounded-lg" />
                      ) : (
                        <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
                          <Github className="size-4 text-muted-foreground" />
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium text-foreground">
                            {source.name}
                          </p>
                          {source.isDefault && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                              <Star className="size-3" /> {copy.defaultBadge}
                            </span>
                          )}
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${source.status === "active" ? "bg-success-bg text-success" : "bg-warning/15 text-warning"}`}
                          >
                            {source.status === "active" ? (
                              <CheckCircle2 className="size-3" />
                            ) : (
                              <AlertTriangle className="size-3" />
                            )}
                            {source.status === "active" ? copy.activeBadge : copy.invalidBadge}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {source.appName || source.slug} · App ID {source.appId}
                        </p>
                        {source.apiBaseUrl !== DEFAULT_API && (
                          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                            {source.apiBaseUrl}
                          </p>
                        )}
                      </div>
                    </div>

                    {source.lastError && (
                      <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                        {source.lastError}
                      </p>
                    )}
                    {staleWebhook && (
                      <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                        {copy.webhookChanged}
                      </p>
                    )}

                    <div className="mt-3 space-y-2">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {copy.installations}
                      </p>
                      {source.installations.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{copy.noInstallations}</p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {source.installations.map((installation) => (
                            <span
                              key={installation.id}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs text-foreground"
                            >
                              <img
                                src={installation.avatarUrl}
                                alt=""
                                className="size-4 rounded-full"
                              />
                              {installation.owner}
                              {installation.suspendedAt && (
                                <span className="text-warning">({copy.suspended})</span>
                              )}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-border/40 pt-3">
                      <button
                        onClick={() => void install(source)}
                        disabled={busy === source.id || source.status !== "active"}
                        className={actionClass}
                      >
                        <Plus className="size-3.5" /> {copy.installAccount}
                      </button>
                      <button
                        onClick={() => void verify(source)}
                        disabled={busy === source.id}
                        className={actionClass}
                      >
                        {busy === source.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="size-3.5" />
                        )}
                        {copy.verify}
                      </button>
                      <button
                        onClick={() => {
                          setEditing(editing === source.id ? null : source.id);
                          setPanel(null);
                        }}
                        className={actionClass}
                      >
                        <Pencil className="size-3.5" /> {copy.edit}
                      </button>
                      {!source.isDefault && source.status === "active" && (
                        <button
                          onClick={() => void makeDefault(source)}
                          disabled={busy === source.id}
                          className={actionClass}
                        >
                          <Star className="size-3.5" /> {copy.makeDefault}
                        </button>
                      )}
                      <a
                        href={source.managementUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={actionClass}
                      >
                        {copy.manage} <ExternalLink className="size-3" />
                      </a>
                      <button
                        onClick={() => void remove(source)}
                        disabled={busy === source.id}
                        className={`${actionClass} ms-auto text-danger hover:bg-danger-bg`}
                      >
                        <Trash2 className="size-3.5" /> {copy.delete}
                      </button>
                    </div>

                    {editing === source.id && configuration && (
                      <div className="mt-4">
                        <SourceForm
                          source={source}
                          configuration={configuration}
                          onCancel={() => setEditing(null)}
                          onSaved={async () => {
                            setEditing(null);
                            await load();
                            githubApi.invalidateStatus();
                          }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

const inputClass =
  "w-full rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20";
const actionClass =
  "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40";

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {help && (
        <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">{help}</span>
      )}
    </label>
  );
}

function FormActions(props: {
  saving: boolean;
  disabled: boolean;
  saveLabel: string;
  cancelLabel: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={props.onSave}
        disabled={props.saving || props.disabled}
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
      >
        {props.saving && <Loader2 className="size-4 animate-spin" />}
        {props.saveLabel}
      </button>
      <button
        type="button"
        onClick={props.onCancel}
        disabled={props.saving}
        className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
      >
        {props.cancelLabel}
      </button>
    </div>
  );
}

function SourceForm({
  source,
  configuration,
  onCancel,
  onSaved,
  onExternalFlowStarted,
}: {
  source?: GitHubSource;
  configuration: GitHubSourceConfiguration;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onExternalFlowStarted?: () => void;
}) {
  const { t } = useI18n();
  const copy = t.settings.githubSources;
  const { showToast } = useToast();
  const [name, setName] = useState(source?.name ?? "");
  const [appId, setAppId] = useState(source ? String(source.appId) : "");
  const [clientId, setClientId] = useState(source?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState(source?.apiBaseUrl ?? DEFAULT_API);
  const [webBaseUrl, setWebBaseUrl] = useState(source?.webBaseUrl ?? DEFAULT_WEB);
  const [isDefault, setIsDefault] = useState(source?.isDefault ?? false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const popup = source ? null : openPendingWindow(`openship-github-install-${Date.now()}`);
    setSaving(true);
    try {
      if (source) {
        const input: UpdateGitHubSourceInput = {
          name,
          appId: Number(appId),
          clientId: clientId.trim() || null,
          apiBaseUrl,
          webBaseUrl,
          ...(clientSecret.trim() ? { clientSecret } : {}),
          ...(privateKeyPem.trim() ? { privateKeyPem } : {}),
          ...(webhookSecret.trim() ? { webhookSecret } : {}),
        };
        await githubApi.updateSource(source.id, input);
        showToast(copy.toast.updated, "success");
        await onSaved();
      } else {
        const input: ManualGitHubSourceInput = {
          name,
          appId: Number(appId),
          clientId: clientId.trim() || undefined,
          clientSecret: clientSecret.trim() || undefined,
          privateKeyPem,
          webhookSecret,
          apiBaseUrl,
          webBaseUrl,
          isDefault,
        };
        const result = await githubApi.createSourceManual(input);
        showToast(copy.toast.created, "success");
        onExternalFlowStarted?.();
        navigateWindow(popup, result.installUrl);
        await onSaved();
      }
    } catch (error) {
      popup?.close();
      showToast(getApiErrorMessage(error, copy.toast.saveFailed), "error");
    } finally {
      setSaving(false);
    }
  };

  const canSave =
    Boolean(name.trim()) &&
    Number.isSafeInteger(Number(appId)) &&
    Number(appId) > 0 &&
    (source ? true : Boolean(privateKeyPem.trim()) && webhookSecret.trim().length >= 16);

  return (
    <div className="space-y-3 rounded-xl border border-border/50 bg-muted/20 p-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {source ? copy.editHelp : copy.manualHelp}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={copy.nameLabel}>
          <input
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            placeholder={copy.namePlaceholder}
            className={inputClass}
          />
        </Field>
        <Field label={copy.appIdLabel}>
          <input
            inputMode="numeric"
            value={appId}
            onChange={(event) => setAppId(event.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            className={`${inputClass} font-mono`}
          />
        </Field>
        <Field label={copy.clientIdLabel} help={copy.optionalHelp}>
          <input
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            className={`${inputClass} font-mono`}
          />
        </Field>
        <Field label={copy.clientSecretLabel} help={source ? copy.leaveBlank : copy.optionalHelp}>
          <input
            type="password"
            autoComplete="new-password"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            className={`${inputClass} font-mono`}
          />
        </Field>
      </div>
      <Field label={copy.privateKeyLabel} help={source ? copy.leaveBlank : copy.privateKeyHelp}>
        <textarea
          value={privateKeyPem}
          onChange={(event) => setPrivateKeyPem(event.target.value)}
          rows={5}
          className={`${inputClass} resize-y font-mono text-xs`}
          placeholder="-----BEGIN RSA PRIVATE KEY-----"
        />
      </Field>
      <Field
        label={copy.webhookSecretLabel}
        help={source ? copy.leaveBlank : copy.webhookSecretHelp}
      >
        <input
          type="password"
          autoComplete="new-password"
          value={webhookSecret}
          onChange={(event) => setWebhookSecret(event.target.value)}
          className={`${inputClass} font-mono`}
        />
      </Field>
      <details>
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          {copy.enterpriseSettings}
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label={copy.webUrlLabel}>
            <input
              value={webBaseUrl}
              onChange={(event) => setWebBaseUrl(event.target.value)}
              className={`${inputClass} font-mono text-xs`}
            />
          </Field>
          <Field label={copy.apiUrlLabel}>
            <input
              value={apiBaseUrl}
              onChange={(event) => setApiBaseUrl(event.target.value)}
              className={`${inputClass} font-mono text-xs`}
            />
          </Field>
        </div>
      </details>
      {!source && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(event) => setIsDefault(event.target.checked)}
          />
          {copy.defaultLabel}
        </label>
      )}
      <div className="space-y-1 rounded-lg bg-muted/35 px-3 py-2 font-mono text-[10px] text-muted-foreground">
        <p className="break-all">
          {copy.setupUrlLabel}: {configuration.setupUrl}
        </p>
        <p className="break-all">
          {copy.webhookUrlLabel}: {configuration.webhookUrl}
        </p>
      </div>
      <FormActions
        saving={saving}
        disabled={!canSave}
        saveLabel={source ? t.settings.common.save : copy.registerAndInstall}
        cancelLabel={t.settings.common.cancel}
        onSave={() => void save()}
        onCancel={onCancel}
      />
    </div>
  );
}
