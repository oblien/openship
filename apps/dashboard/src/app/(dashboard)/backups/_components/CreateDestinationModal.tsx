"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Cloud,
  Server,
  ServerCog,
  HardDrive,
  Database,
  Lock,
  Loader2,
  CheckCircle2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { ServerSelector } from "@/components/shared";
import {
  backupDestinationsApi,
  type BackupDestinationSummary,
  type CreateDestinationInput,
  getApiErrorMessage,
} from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";

type Kind = Exclude<BackupDestinationSummary["kind"], "http_upload" | "local">;

interface KindOption {
  kind: Kind;
  icon: LucideIcon;
}

const KIND_OPTIONS: KindOption[] = [
  { kind: "s3_compatible", icon: Cloud },
  { kind: "sftp", icon: Server },
  { kind: "openship_server", icon: ServerCog },
];

// ─── S3 providers ────────────────────────────────────────────────────────────
// The provider is UI sugar: it decides how the canonical `endpoint`/`region`
// stored on the destination are built, and which helper field the user fills.
// Brand marks come from the simpleicons CDN (brand color by default), falling
// back to a tinted lucide glyph when a slug is missing / offline.

type S3ProviderId = "aws" | "r2" | "b2" | "wasabi" | "do" | "minio";

/** Which extra input a provider needs beyond bucket + credentials. */
type S3Mode = "region" | "accountId" | "endpoint";

interface S3Provider {
  id: S3ProviderId;
  /** Fallback label (i18n overrides via providerLabels). */
  label: string;
  slug?: string;
  color: string;
  icon: LucideIcon;
  mode: S3Mode;
  regionPlaceholder?: string;
}

const S3_PROVIDERS: S3Provider[] = [
  { id: "aws", label: "AWS S3", slug: "amazons3", color: "#569A31", icon: Cloud, mode: "region", regionPlaceholder: "us-east-1" },
  { id: "r2", label: "Cloudflare R2", slug: "cloudflare", color: "#F38020", icon: Cloud, mode: "accountId" },
  { id: "b2", label: "Backblaze B2", slug: "backblaze", color: "#E21E29", icon: HardDrive, mode: "region", regionPlaceholder: "us-west-004" },
  { id: "wasabi", label: "Wasabi", color: "#01CD3E", icon: Database, mode: "region", regionPlaceholder: "us-east-1" },
  { id: "do", label: "DigitalOcean Spaces", slug: "digitalocean", color: "#0080FF", icon: Cloud, mode: "region", regionPlaceholder: "nyc3" },
  { id: "minio", label: "MinIO / Custom", slug: "minio", color: "#C72E49", icon: Server, mode: "endpoint" },
];

/** provider id → misc.backups i18n key (the dict is flat string→string). */
const PROVIDER_LABEL_KEY: Record<S3ProviderId, string> = {
  aws: "providerAws",
  r2: "providerR2",
  b2: "providerB2",
  wasabi: "providerWasabi",
  do: "providerDo",
  minio: "providerMinio",
};

function providerById(id: S3ProviderId): S3Provider {
  return S3_PROVIDERS.find((p) => p.id === id) ?? S3_PROVIDERS[0];
}

/** Build the canonical endpoint + region for a provider from its helper inputs. */
function buildS3Endpoint(
  provider: S3ProviderId,
  fields: { region: string; accountId: string; endpoint: string },
): { endpoint: string | null; region: string | null } {
  const region = fields.region.trim();
  const accountId = fields.accountId.trim();
  const endpoint = fields.endpoint.trim();
  switch (provider) {
    case "aws":
      return { endpoint: null, region: region || "us-east-1" };
    case "r2":
      return {
        endpoint: accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null,
        region: "auto",
      };
    case "b2":
      return { endpoint: region ? `https://s3.${region}.backblazeb2.com` : null, region: region || null };
    case "wasabi":
      return { endpoint: region ? `https://s3.${region}.wasabisys.com` : null, region: region || null };
    case "do":
      return { endpoint: region ? `https://${region}.digitaloceanspaces.com` : null, region: region || null };
    case "minio":
      return { endpoint: endpoint || null, region: region || "us-east-1" };
  }
}

/** Reverse-derive the provider (and its helper inputs) from a stored endpoint —
 *  so edit mode opens on the right provider tab pre-filled. */
function deriveS3Provider(
  endpoint: string | null,
  region: string | null,
): { provider: S3ProviderId; region: string; accountId: string; endpoint: string } {
  const ep = endpoint ?? "";
  let match: RegExpMatchArray | null;
  if (!ep || ep.includes(".amazonaws.com")) {
    return { provider: "aws", region: region ?? "", accountId: "", endpoint: "" };
  }
  if ((match = ep.match(/^https?:\/\/([a-z0-9]+)\.r2\.cloudflarestorage\.com/i))) {
    return { provider: "r2", region: "auto", accountId: match[1], endpoint: "" };
  }
  if ((match = ep.match(/^https?:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com/i))) {
    return { provider: "b2", region: match[1] ?? region ?? "", accountId: "", endpoint: "" };
  }
  if (ep.includes(".wasabisys.com")) {
    match = ep.match(/s3\.([a-z0-9-]+)\.wasabisys\.com/i);
    return { provider: "wasabi", region: match?.[1] ?? region ?? "", accountId: "", endpoint: "" };
  }
  if (ep.includes(".digitaloceanspaces.com")) {
    match = ep.match(/^https?:\/\/([a-z0-9-]+)\.digitaloceanspaces\.com/i);
    return { provider: "do", region: match?.[1] ?? region ?? "", accountId: "", endpoint: "" };
  }
  return { provider: "minio", region: region ?? "", accountId: "", endpoint: ep };
}

/** Brand mark: simpleicons CDN (brand-colored) with a tinted lucide fallback. */
function ProviderMark({
  slug,
  color,
  icon: Icon = Database,
  className = "size-5",
}: {
  slug?: string;
  color?: string;
  icon?: LucideIcon;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (slug && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`https://cdn.simpleicons.org/${slug}`}
        alt=""
        className={className}
        onError={() => setFailed(true)}
      />
    );
  }
  return <Icon className={className} style={color ? { color } : undefined} />;
}

/** Translated display title for a destination kind. */
function kindTitle(kind: Kind, m: Record<string, string>): string {
  switch (kind) {
    case "s3_compatible":
      return m.kindS3;
    case "sftp":
      return m.kindSftp;
    case "openship_server":
      return m.kindServer;
  }
}

/** Translated description + examples for a destination kind (picker cards). */
function kindMeta(kind: Kind, m: Record<string, string>): { description: string; examples: string } {
  switch (kind) {
    case "s3_compatible":
      return { description: m.s3Desc, examples: m.s3Examples };
    case "sftp":
      return { description: m.sftpDesc, examples: m.sftpExamples };
    case "openship_server":
      return { description: m.serverDesc, examples: m.serverExamples };
  }
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  /** When set, the modal edits this destination instead of creating one:
   *  the kind picker is skipped, fields are pre-filled, and secrets are left
   *  blank (blank = keep the stored value). */
  destination?: BackupDestinationSummary | null;
}

type Step = "pick" | "configure";

export function CreateDestinationModal({ isOpen, onClose, onSaved, destination }: Props) {
  const { t } = useI18n();
  const m = t.misc.backups;
  const editing = !!destination;
  const [step, setStep] = useState<Step>("pick");
  const [selectedKind, setSelectedKind] = useState<Kind | null>(null);

  // Reset state every time the modal opens. In edit mode jump straight to the
  // configure step with the destination's (fixed) kind.
  useEffect(() => {
    if (!isOpen) return;
    if (
      destination &&
      destination.kind !== "http_upload" &&
      destination.kind !== "local"
    ) {
      setSelectedKind(destination.kind);
      setStep("configure");
    } else {
      setSelectedKind(null);
      setStep("pick");
    }
  }, [isOpen, destination]);

  const selectedTitle = selectedKind ? kindTitle(selectedKind, m) : null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidth={step === "pick" ? "900px" : "760px"}
      width="100%"
      maxHeight="92vh"
    >
      <div className="flex max-h-[92vh] flex-col">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border/40 px-6 py-5">
          <div className="flex items-center gap-3 min-w-0">
            {step === "configure" && !editing && (
              <button
                type="button"
                onClick={() => setStep("pick")}
                className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                aria-label={m.backToPicker}
              >
                <ArrowLeft className="size-4 rtl:rotate-180" />
              </button>
            )}
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground truncate">
                {editing
                  ? interpolate(m.modalEditTitle, { name: selectedTitle ?? m.destinationFallback })
                  : step === "pick"
                    ? m.modalAddTitle
                    : interpolate(m.modalNewTitle, { name: selectedTitle ?? m.destinationFallback })}
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground truncate">
                {step === "pick"
                  ? m.modalPickSubtitle
                  : m.modalConfigureSubtitle}
              </p>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <Lock className="size-3.5" />
            {m.encryptedAtRest}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-6 sm:px-8 sm:py-8">
          {step === "pick" ? (
            <KindPicker
              onPick={(kind) => {
                setSelectedKind(kind);
                setStep("configure");
              }}
            />
          ) : selectedKind ? (
            <ConfigureForm
              key={destination?.id ?? "new"}
              kind={selectedKind}
              destination={destination ?? null}
              onCancel={onClose}
              onSaved={onSaved}
            />
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

// ─── Kind picker (step 1) ────────────────────────────────────────────────────

function KindPicker({ onPick }: { onPick: (kind: Kind) => void }) {
  const { t } = useI18n();
  const m = t.misc.backups;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {KIND_OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const meta = kindMeta(opt.kind, m);
        return (
          <button
            key={opt.kind}
            type="button"
            onClick={() => onPick(opt.kind)}
            className="group flex items-start gap-4 rounded-2xl border border-border/60 bg-card p-5 text-start transition-all hover:border-primary/40 hover:shadow-md hover:-translate-y-0.5"
          >
            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground transition-transform group-hover:scale-105">
              <Icon className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-foreground">
                {kindTitle(opt.kind, m)}
              </p>
              <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
                {meta.description}
              </p>
              {opt.kind === "s3_compatible" ? (
                <div className="mt-3 flex items-center gap-2.5">
                  {S3_PROVIDERS.filter((p) => p.id !== "minio").map((p) => (
                    <ProviderMark
                      key={p.id}
                      slug={p.slug}
                      color={p.color}
                      icon={p.icon}
                      className="size-4 opacity-90"
                    />
                  ))}
                  <span className="text-xs text-muted-foreground/70 font-medium">
                    {m.s3Examples}
                  </span>
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground/70 uppercase tracking-wider font-medium">
                  {meta.examples}
                </p>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Configure form (step 2) — create OR edit ────────────────────────────────

function ConfigureForm({
  kind,
  destination,
  onCancel,
  onSaved,
}: {
  kind: Kind;
  destination: BackupDestinationSummary | null;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const m = t.misc.backups;
  const editing = !!destination;

  // Derive the S3 provider + helper inputs from the stored endpoint (edit) or
  // default to AWS (create).
  const s3Initial = useMemo(
    () =>
      kind === "s3_compatible" && destination
        ? deriveS3Provider(destination.endpoint, destination.region)
        : { provider: "aws" as S3ProviderId, region: "", accountId: "", endpoint: "" },
    [kind, destination],
  );

  const [name, setName] = useState(destination?.name ?? "");
  const [provider, setProvider] = useState<S3ProviderId>(s3Initial.provider);
  const [region, setRegion] = useState(s3Initial.region);
  const [accountId, setAccountId] = useState(s3Initial.accountId);
  const [endpoint, setEndpoint] = useState(s3Initial.endpoint);
  const [bucket, setBucket] = useState(destination?.bucket ?? "");
  const [pathPrefix, setPathPrefix] = useState(destination?.pathPrefix ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sshHost, setSshHost] = useState(destination?.sshHost ?? "");
  const [sshPort, setSshPort] = useState<number | "">(destination?.sshPort ?? 22);
  const [sshUser, setSshUser] = useState(destination?.sshUser ?? "");
  const [sftpPassword, setSftpPassword] = useState("");
  const [sftpPrivateKey, setSftpPrivateKey] = useState("");
  const [serverId, setServerId] = useState(destination?.serverId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ status: "idle" | "testing" | "ok" | "fail"; reason?: string }>({
    status: "idle",
  });

  const activeProvider = providerById(provider);

  // A changed field invalidates a prior test result.
  useEffect(() => {
    setTest({ status: "idle" });
  }, [
    kind, provider, region, accountId, endpoint, bucket, pathPrefix,
    accessKeyId, secretAccessKey, sshHost, sshPort, sshUser,
    sftpPassword, sftpPrivateKey, serverId,
  ]);

  // Placeholder for a secret field that already has a stored value (edit mode):
  // blank submit keeps it, so tell the user that explicitly.
  const secretPlaceholder = (stored: boolean) =>
    editing && stored ? m.secretStoredPlaceholder : undefined;

  const providerLabel = (id: S3ProviderId): string =>
    (m as Record<string, string>)[PROVIDER_LABEL_KEY[id]] ?? providerById(id).label;

  /** Assemble the create/update payload from current field state (shared by
   *  Save and Test). Secrets are omitted when blank in edit mode. */
  const buildInput = (): CreateDestinationInput => {
    const input: CreateDestinationInput = { name: name.trim(), kind };
    if (kind === "s3_compatible") {
      const { endpoint: ep, region: rg } = buildS3Endpoint(provider, { region, accountId, endpoint });
      input.endpoint = ep;
      input.region = rg;
      input.bucket = bucket.trim();
      input.pathPrefix = pathPrefix.trim() || null;
      if (!editing || accessKeyId) input.accessKeyId = accessKeyId;
      if (!editing || secretAccessKey) input.secretAccessKey = secretAccessKey;
    } else if (kind === "sftp") {
      input.sshHost = sshHost.trim();
      input.sshPort = typeof sshPort === "number" ? sshPort : 22;
      input.sshUser = sshUser.trim();
      input.pathPrefix = pathPrefix.trim() || null;
      if (sftpPassword) input.sftpPassword = sftpPassword;
      if (sftpPrivateKey) input.sftpPrivateKey = sftpPrivateKey;
    } else if (kind === "openship_server") {
      input.serverId = serverId;
      input.pathPrefix = pathPrefix.trim() || null;
    }
    return input;
  };

  const runTest = async () => {
    setError(null);
    setTest({ status: "testing" });
    try {
      const res = await backupDestinationsApi.preflightDraft({
        ...buildInput(),
        id: destination?.id,
      });
      if (res.data.ok) setTest({ status: "ok" });
      else setTest({ status: "fail", reason: res.data.reason || m.verificationFailedMsg });
    } catch (err) {
      setTest({ status: "fail", reason: getApiErrorMessage(err, m.verificationFailedTitle) });
    }
  };

  const submit = async () => {
    setError(null);
    const input = buildInput();
    setBusy(true);
    try {
      if (editing && destination) {
        // Kind is immutable — never send it on update.
        const { kind: _kind, ...patch } = input;
        await backupDestinationsApi.update(destination.id, patch);
      } else {
        await backupDestinationsApi.create(input);
      }
      await onSaved();
    } catch (err) {
      setError(
        getApiErrorMessage(err, editing ? m.updateFailed : m.createFailed),
      );
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40";

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      <Field label={m.fieldName}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Production R2"
          className={inputClass}
        />
      </Field>

      {kind === "s3_compatible" && (
        <>
          {/* Provider picker — decides endpoint/region + which helper field to show. */}
          <div>
            <span className="block text-sm font-medium text-foreground mb-2">
              {m.providerLabel}
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {S3_PROVIDERS.map((p) => {
                const on = p.id === provider;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setProvider(p.id)}
                    className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-start transition-all ${
                      on
                        ? "border-primary/50 bg-primary/[0.06] shadow-sm"
                        : "border-border/50 hover:border-border hover:bg-muted/30"
                    }`}
                  >
                    <ProviderMark slug={p.slug} color={p.color} icon={p.icon} className="size-5 shrink-0" />
                    <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                      {providerLabel(p.id)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Provider-specific locator: account id (R2), endpoint (MinIO), region (rest). */}
            {activeProvider.mode === "accountId" && (
              <Field label={m.fieldAccountId} hint={m.hintAccountId}>
                <input
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  placeholder="a1b2c3d4e5f6…"
                  className={`${inputClass} font-mono`}
                />
              </Field>
            )}
            {activeProvider.mode === "endpoint" && (
              <Field label={m.fieldEndpoint} hint={m.hintEndpointMinio}>
                <input
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://minio.example.com:9000"
                  className={inputClass}
                />
              </Field>
            )}
            {(activeProvider.mode === "region" || activeProvider.mode === "endpoint") && (
              <Field label={m.fieldRegion}>
                <input
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  placeholder={activeProvider.regionPlaceholder ?? "us-east-1"}
                  className={inputClass}
                />
              </Field>
            )}
            <Field label={m.fieldBucket}>
              <input
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
                placeholder="my-backups"
                className={inputClass}
              />
            </Field>
            <Field label={m.fieldPathPrefix} hint={m.hintPathPrefix}>
              <input
                value={pathPrefix}
                onChange={(e) => setPathPrefix(e.target.value)}
                placeholder="openship/prod"
                className={inputClass}
              />
            </Field>
            <Field label={m.fieldAccessKeyId}>
              <input
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
                placeholder={secretPlaceholder(destination?.hasAccessKeyId ?? false)}
                className={`${inputClass} font-mono`}
              />
            </Field>
            <Field label={m.fieldSecretAccessKey}>
              <input
                value={secretAccessKey}
                onChange={(e) => setSecretAccessKey(e.target.value)}
                type="password"
                placeholder={secretPlaceholder(destination?.hasSecretAccessKey ?? false)}
                className={`${inputClass} font-mono`}
              />
            </Field>
          </div>
        </>
      )}

      {kind === "sftp" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label={m.fieldHost}>
            <input
              value={sshHost}
              onChange={(e) => setSshHost(e.target.value)}
              placeholder="backups.example.com"
              className={inputClass}
            />
          </Field>
          <Field label={m.fieldPort}>
            <input
              type="number"
              value={sshPort}
              onChange={(e) =>
                setSshPort(e.target.value === "" ? "" : Number(e.target.value))
              }
              className={inputClass}
            />
          </Field>
          <Field label={m.fieldUser}>
            <input
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              placeholder="backup"
              className={inputClass}
            />
          </Field>
          <Field label={m.fieldPathPrefix}>
            <input
              value={pathPrefix}
              onChange={(e) => setPathPrefix(e.target.value)}
              placeholder="/backups/openship"
              className={inputClass}
            />
          </Field>
          <Field label={m.fieldPassword} hint={m.hintPassword}>
            <input
              value={sftpPassword}
              onChange={(e) => setSftpPassword(e.target.value)}
              type="password"
              placeholder={secretPlaceholder(destination?.hasSftpPassword ?? false)}
              className={`${inputClass} font-mono`}
            />
          </Field>
          <Field label={m.fieldPrivateKey} hint={m.hintPrivateKey}>
            <textarea
              value={sftpPrivateKey}
              onChange={(e) => setSftpPrivateKey(e.target.value)}
              rows={4}
              placeholder={
                secretPlaceholder(destination?.hasSftpPrivateKey ?? false) ??
                "-----BEGIN OPENSSH PRIVATE KEY-----"
              }
              className="w-full rounded-xl border border-border/50 bg-muted/20 px-3 py-2.5 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
        </div>
      )}

      {kind === "openship_server" && (
        <div className="grid grid-cols-1 gap-4">
          <Field label={m.fieldServer} hint={m.hintServer}>
            <ServerSelector
              value={serverId || null}
              onSelect={(s) => setServerId(s?.id ?? "")}
              compact
            />
          </Field>
          <Field label={m.fieldRemotePath} hint={m.hintRemotePath}>
            <input
              value={pathPrefix}
              onChange={(e) => setPathPrefix(e.target.value)}
              placeholder="/backups/openship"
              className={`${inputClass} font-mono`}
            />
          </Field>
        </div>
      )}

      {/* Test-connection result — the end-to-end probe (writes + deletes a
          probe object / opens the SSH session). */}
      {test.status !== "idle" && (
        <div
          className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${
            test.status === "ok"
              ? "border-success-border bg-success-bg text-success"
              : test.status === "fail"
                ? "border-danger-border bg-danger-bg text-danger"
                : "border-border/50 bg-muted/20 text-muted-foreground"
          }`}
        >
          {test.status === "testing" && <Loader2 className="size-4 mt-0.5 shrink-0 animate-spin" />}
          {test.status === "ok" && <CheckCircle2 className="size-4 mt-0.5 shrink-0" />}
          {test.status === "fail" && <XCircle className="size-4 mt-0.5 shrink-0" />}
          <span className="min-w-0">
            {test.status === "testing"
              ? m.testing
              : test.status === "ok"
                ? m.testOk
                : (test.reason ?? m.verificationFailedMsg)}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-6 border-t border-border/40 -mx-6 px-6 -mb-6 pb-6 sm:-mx-8 sm:px-8 sm:-mb-8 sm:pb-8 mt-2">
        <Button
          type="button"
          variant="outline"
          onClick={runTest}
          disabled={busy || test.status === "testing" || !name.trim()}
        >
          {test.status === "testing" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <CheckCircle2 />
          )}
          {m.testConnection}
        </Button>
        <div className="flex items-center gap-3 ms-auto">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {m.cancel}
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy ? m.saving : editing ? m.saveChanges : m.saveDestination}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-foreground mb-1.5">
        {label}
      </span>
      {hint && (
        <span className="block text-xs text-muted-foreground mb-1.5">
          {hint}
        </span>
      )}
      {children}
    </label>
  );
}
