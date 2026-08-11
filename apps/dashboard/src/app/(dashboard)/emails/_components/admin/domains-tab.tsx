"use client";

/**
 * Domains tab - list + create/edit/delete for vmail.domain rows.
 *
 * Real table layout (DataTable primitive) with sticky header, dense
 * rows, and proper columns: Domain · Mailboxes · Aliases · Quota ·
 * Status · actions. Skeleton placeholders cover loading.
 */

import { useCallback, useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Globe } from "lucide-react";
import {
  mailAdminApi,
  type AdminDomain,
  type AdditionalDomainDnsState,
  getApiErrorMessage,
} from "@/lib/api";
import { useModal } from "@/context/ModalContext";
import {
  DataTable,
  RowIconButton,
  type DataTableColumn,
} from "./_shared/data-table";
import { StatusPill } from "./_shared/status-pill";
import {
  Field,
  FormModalContent,
  inputClassName,
} from "./_shared/form-modal-content";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { DnsRecords } from "@/lib/api";
import { DnsHoldBanner } from "../dns-hold-banner";
import {
  ReputationBanner,
  REPUTATION_STORAGE_PREFIX,
  reputationStorageKey,
} from "./reputation-banner";
import { WelcomeModal } from "./welcome-modal";

interface DomainsTabProps {
  serverId: string;
  primaryDomain: string;
  /**
   * Invoked after a successful domain delete. The parent uses this to
   * clear `?domain=<deleted>` from the URL so the Mailboxes tab doesn't
   * keep fetching from a domain that no longer exists.
   */
  onDomainDeleted?: (domain: string) => void;
}

export function DomainsTab({
  serverId,
  primaryDomain,
  onDomainDeleted,
}: DomainsTabProps) {
  const { showModal, hideModal } = useModal();
  const { showToast } = useToast();
  const { t } = useI18n();
  const [rows, setRows] = useState<AdminDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDns, setPendingDns] = useState<AdditionalDomainDnsState[]>([]);
  const [acknowledging, setAcknowledging] = useState<string | null>(null);
  // Additional domains currently in their 7-day reputation warm-up window.
  // Seeded from localStorage on mount and updated whenever the operator
  // acks a new domain. Excludes the primary install - its banner lives at
  // the admin-panel level.
  const [warmupDomains, setWarmupDomains] = useState<string[]>([]);
  // The additional domain (if any) whose welcome / test-email modal is
  // currently open. Set right after the operator acks the DNS banner so
  // the modal can fire a real test FROM the freshly-published domain -
  // proving MX/SPF/DKIM/DMARC end-to-end against the records they just
  // pasted into their provider.
  const [welcomeFor, setWelcomeFor] = useState<string | null>(null);

  const acknowledgeDomain = useCallback(
    async (domain: string) => {
      setAcknowledging(domain);
      try {
        await mailAdminApi.domains.acknowledgeDns(serverId, domain);
        // Seed the reputation warm-up clock for this domain right now -
        // ack is when the domain effectively starts sending. Banner picks
        // it up on next mount of <ReputationBanner /> for this domain.
        if (typeof window !== "undefined" && domain !== primaryDomain) {
          const key = reputationStorageKey(serverId, domain);
          if (!window.localStorage.getItem(key)) {
            window.localStorage.setItem(
              key,
              JSON.stringify({ installedAt: Date.now(), dismissed: false }),
            );
          }
          setWarmupDomains((prev) =>
            prev.includes(domain) ? prev : [...prev, domain],
          );
        }
        await reload();
        // Open the welcome / test-email modal AS the additional domain.
        // The primary install's welcome modal already fires from the
        // install flow at /emails - re-firing it here would be a dupe.
        if (domain !== primaryDomain) {
          setWelcomeFor(domain);
        }
      } catch (err) {
        showToast(
          getApiErrorMessage(err, t.emailsAdmin.domains.acknowledgeFailed),
          "error",
        );
      } finally {
        setAcknowledging(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverId, primaryDomain, showToast],
  );

  // Scan localStorage once on mount to pick up any additional domains
  // that are still inside their warm-up window (e.g. acked in a previous
  // session). Filter out dismissed ones and any that have aged out.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const prefix = `${REPUTATION_STORAGE_PREFIX}${serverId}:`;
    const now = Date.now();
    const out: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const domain = k.slice(prefix.length);
      if (!domain || domain === primaryDomain) continue;
      try {
        const raw = window.localStorage.getItem(k);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as {
          installedAt?: number;
          dismissed?: boolean;
        };
        if (parsed.dismissed) continue;
        if (typeof parsed.installedAt !== "number") continue;
        const elapsedDays = (now - parsed.installedAt) / (1000 * 60 * 60 * 24);
        if (elapsedDays >= 7) continue;
        out.push(domain);
      } catch {
        /* ignore malformed entries */
      }
    }
    setWarmupDomains(out);
  }, [serverId, primaryDomain]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [domainsRes, pendingRes] = await Promise.all([
        mailAdminApi.domains.list(serverId),
        mailAdminApi.domains.pendingDns(serverId).catch(() => ({ pending: [] })),
      ]);
      setRows(domainsRes.domains);
      setPendingDns(pendingRes.pending);
    } catch (err) {
      setError(getApiErrorMessage(err, t.emailsAdmin.domains.loadFailed));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openCreate = () => {
    const id = showModal({
      maxWidth: "520px",
      showCloseButton: false,
      customContent: (
        <CreateDomainForm
          onCancel={() => hideModal(id)}
          onCreated={() => {
            hideModal(id);
            void reload();
          }}
          serverId={serverId}
        />
      ),
    });
  };

  const openEdit = (row: AdminDomain) => {
    const id = showModal({
      maxWidth: "520px",
      showCloseButton: false,
      customContent: (
        <EditDomainForm
          serverId={serverId}
          row={row}
          onCancel={() => hideModal(id)}
          onSaved={() => {
            hideModal(id);
            void reload();
          }}
        />
      ),
    });
  };

  const openDelete = (row: AdminDomain) => {
    const id = showModal({
      maxWidth: "480px",
      showCloseButton: false,
      customContent: (
        <DeleteDomainConfirm
          serverId={serverId}
          row={row}
          onCancel={() => hideModal(id)}
          onDeleted={() => {
            hideModal(id);
            // Clear the per-domain reputation warm-up record from
            // localStorage and from in-memory state so the banner stops
            // rendering for a domain that no longer exists. Banner state
            // lives entirely client-side - the backend already drops the
            // DNS-pending record inside `deleteDomain`.
            if (typeof window !== "undefined") {
              window.localStorage.removeItem(
                reputationStorageKey(serverId, row.domain),
              );
            }
            setWarmupDomains((prev) => prev.filter((d) => d !== row.domain));
            onDomainDeleted?.(row.domain);
            void reload();
          }}
        />
      ),
    });
  };

  const columns: DataTableColumn<AdminDomain>[] = [
    {
      key: "domain",
      header: t.emailsAdmin.domains.colDomain,
      width: "minmax(220px, 1.5fr)",
      cell: (r) => (
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
            <Globe className="size-4 text-muted-foreground" strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate">
              {r.domain}
            </p>
            {r.description && (
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {r.description}
              </p>
            )}
          </div>
        </div>
      ),
    },
    {
      key: "mailboxes",
      header: t.emailsAdmin.domains.colMailboxes,
      width: "110px",
      align: "right",
      hideBelow: "md",
      cell: (r) => (
        <span className="text-sm text-foreground tabular-nums">
          {r.mailboxes}
        </span>
      ),
    },
    {
      key: "aliases",
      header: t.emailsAdmin.domains.colAliases,
      width: "110px",
      align: "right",
      hideBelow: "md",
      cell: (r) => (
        <span className="text-sm text-foreground tabular-nums">
          {r.aliases}
        </span>
      ),
    },
    {
      key: "quota",
      header: t.emailsAdmin.domains.colQuota,
      width: "130px",
      align: "right",
      hideBelow: "lg",
      cell: (r) => (
        <span className="text-sm text-muted-foreground tabular-nums">
          {r.defaultQuotaMB > 0
            ? `${(r.defaultQuotaMB / 1024).toFixed(1)} GB`
            : "-"}
        </span>
      ),
    },
    {
      key: "status",
      header: t.emailsAdmin.domains.colStatus,
      width: "120px",
      cell: (r) => (
        <div className="flex items-center gap-1.5 flex-wrap">
          {r.active ? (
            <StatusPill tone="success" dot>
              {t.emailsAdmin.domains.active}
            </StatusPill>
          ) : (
            <StatusPill tone="neutral" dot>
              {t.emailsAdmin.domains.disabled}
            </StatusPill>
          )}
          {r.domain === primaryDomain && (
            <StatusPill tone="info">{t.emailsAdmin.domains.primary}</StatusPill>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">
            {t.emailsAdmin.domains.heading}
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">
            {t.emailsAdmin.domains.description}
          </p>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 shrink-0"
        >
          <Plus className="size-4" />
          {t.emailsAdmin.domains.addDomain}
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {pendingDns.length > 0 && (
        <div className="space-y-4">
          {pendingDns.map((p) => (
            <DnsHoldBanner
              key={p.domain}
              records={p.records as unknown as DnsRecords}
              domain={p.domain}
              title={interpolate(t.emailsAdmin.domains.pendingTitle, { domain: p.domain })}
              description={
                <>
                  {t.emailsAdmin.domains.pendingDescBefore}
                  <strong>{p.domain}</strong>
                  {t.emailsAdmin.domains.pendingDescAfter}
                  <strong>{t.emailsAdmin.domains.pendingDescAction}</strong>
                  {t.emailsAdmin.domains.pendingDescEnd}
                </>
              }
              acknowledging={acknowledging === p.domain}
              onAcknowledge={() => void acknowledgeDomain(p.domain)}
            />
          ))}
        </div>
      )}

      {warmupDomains.length > 0 && (
        <div className="space-y-3">
          {warmupDomains.map((d) => (
            <ReputationBanner key={d} serverId={serverId} domain={d} />
          ))}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.domain}
        loading={loading}
        rowActions={(row) => (
          <>
            <RowIconButton
              icon={Pencil}
              label={t.emailsAdmin.domains.editAction}
              onClick={() => openEdit(row)}
            />
            <RowIconButton
              icon={Trash2}
              label={t.emailsAdmin.domains.deleteAction}
              variant="danger"
              disabled={row.domain === primaryDomain && row.mailboxes > 0}
              onClick={() => openDelete(row)}
            />
          </>
        )}
        empty={{
          icon: Globe,
          title: t.emailsAdmin.domains.emptyTitle,
          description: t.emailsAdmin.domains.emptyDesc,
          action: (
            <button
              onClick={openCreate}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-colors"
            >
              <Plus className="size-4" />
              {t.emailsAdmin.domains.addDomain}
            </button>
          ),
        }}
      />

      {welcomeFor && (
        <WelcomeModal
          serverId={serverId}
          domain={welcomeFor}
          onClose={() => setWelcomeFor(null)}
        />
      )}
    </div>
  );
}

// ─── Create form ─────────────────────────────────────────────────────────────

function CreateDomainForm({
  serverId,
  onCancel,
  onCreated,
}: {
  serverId: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const [domain, setDomain] = useState("");
  const [description, setDescription] = useState("");
  const [defaultQuotaGB, setDefaultQuotaGB] = useState("");

  const submit = async () => {
    const res = await mailAdminApi.domains.create(serverId, {
      domain: domain.trim().toLowerCase(),
      description: description.trim() || undefined,
      defaultQuotaMB: defaultQuotaGB
        ? Math.round(Number(defaultQuotaGB) * 1024)
        : undefined,
    });
    if (res.dnsWarning) {
      // The domain row was created but DKIM/DNS provisioning failed -
      // surface the reason so the operator knows why no banner will
      // appear and what to fix.
      showToast(res.dnsWarning, "error");
    }
    onCreated();
  };

  return (
    <FormModalContent
      title={t.emailsAdmin.domains.create.title}
      description={t.emailsAdmin.domains.create.description}
      submitLabel={t.emailsAdmin.domains.create.submit}
      submittingLabel={t.emailsAdmin.domains.create.submitting}
      onSubmit={submit}
      onCancel={onCancel}
      disabled={!domain.trim()}
    >
      <Field label={t.emailsAdmin.domains.create.domainLabel} hint={t.emailsAdmin.domains.create.domainHint}>
        <input
          type="text"
          autoFocus
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="acme.com"
          className={inputClassName}
        />
      </Field>
      <Field label={t.emailsAdmin.domains.create.descLabel} hint={t.emailsAdmin.domains.create.descHint}>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t.emailsAdmin.domains.create.descPlaceholder}
          className={inputClassName}
        />
      </Field>
      <Field
        label={t.emailsAdmin.domains.create.quotaLabel}
        hint={t.emailsAdmin.domains.create.quotaHint}
      >
        <input
          type="number"
          min={0}
          step={0.5}
          value={defaultQuotaGB}
          onChange={(e) => setDefaultQuotaGB(e.target.value)}
          placeholder="5"
          className={inputClassName}
        />
      </Field>
    </FormModalContent>
  );
}

// ─── Edit form ───────────────────────────────────────────────────────────────

function EditDomainForm({
  serverId,
  row,
  onCancel,
  onSaved,
}: {
  serverId: string;
  row: AdminDomain;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [description, setDescription] = useState(row.description);
  const [defaultQuotaGB, setDefaultQuotaGB] = useState(
    row.defaultQuotaMB > 0 ? String(row.defaultQuotaMB / 1024) : "",
  );
  const [active, setActive] = useState(row.active);

  const submit = async () => {
    await mailAdminApi.domains.update(serverId, row.domain, {
      description,
      defaultQuotaMB: defaultQuotaGB ? Math.round(Number(defaultQuotaGB) * 1024) : 0,
      active,
    });
    onSaved();
  };

  return (
    <FormModalContent
      title={interpolate(t.emailsAdmin.domains.editForm.title, { domain: row.domain })}
      submitLabel={t.emailsAdmin.domains.editForm.submit}
      submittingLabel={t.emailsAdmin.domains.editForm.submitting}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <Field label={t.emailsAdmin.domains.editForm.descLabel}>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputClassName}
        />
      </Field>
      <Field
        label={t.emailsAdmin.domains.editForm.quotaLabel}
        hint={t.emailsAdmin.domains.editForm.quotaHint}
      >
        <input
          type="number"
          min={0}
          step={0.5}
          value={defaultQuotaGB}
          onChange={(e) => setDefaultQuotaGB(e.target.value)}
          className={inputClassName}
        />
      </Field>
      <label className="flex items-start gap-3 cursor-pointer p-3 -mx-1 rounded-xl hover:bg-muted/30 transition-colors">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          className="rounded border-border mt-0.5"
        />
        <span>
          <span className="block text-sm font-medium text-foreground">
            {t.emailsAdmin.domains.editForm.activeLabel}
          </span>
          <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">
            {t.emailsAdmin.domains.editForm.activeDesc}
          </span>
        </span>
      </label>
    </FormModalContent>
  );
}

// ─── Delete confirm ──────────────────────────────────────────────────────────

function DeleteDomainConfirm({
  serverId,
  row,
  onCancel,
  onDeleted,
}: {
  serverId: string;
  row: AdminDomain;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const dt = t.emailsAdmin.domains.deleteForm;
  const hasDependents = row.mailboxes > 0 || row.aliases > 0;
  const [cascade, setCascade] = useState(false);

  const partsLabel = [
    row.mailboxes > 0
      ? interpolate(row.mailboxes === 1 ? dt.mailboxOne : dt.mailboxOther, {
          count: String(row.mailboxes),
        })
      : null,
    row.aliases > 0
      ? interpolate(row.aliases === 1 ? dt.aliasOne : dt.aliasOther, {
          count: String(row.aliases),
        })
      : null,
  ]
    .filter(Boolean)
    .join(dt.partsJoin);

  const submit = async () => {
    if (hasDependents && !cascade) {
      throw new Error(
        interpolate(dt.errorDependents, {
          mailboxes: String(row.mailboxes),
          aliases: String(row.aliases),
        }),
      );
    }
    await mailAdminApi.domains.delete(serverId, row.domain, {
      cascade: hasDependents ? cascade : false,
    });
    onDeleted();
  };

  return (
    <FormModalContent
      title={interpolate(dt.title, { domain: row.domain })}
      description={
        hasDependents
          ? interpolate(dt.descDependents, { parts: partsLabel })
          : dt.descSimple
      }
      submitLabel={hasDependents && cascade ? interpolate(dt.submitWithParts, { parts: partsLabel }) : dt.submit}
      submittingLabel={dt.submitting}
      submitVariant="danger"
      onSubmit={submit}
      onCancel={onCancel}
      disabled={hasDependents && !cascade}
    >
      {hasDependents ? (
        <label className="flex items-start gap-2.5 cursor-pointer rounded-lg border border-danger-border bg-danger-bg px-3 py-2.5">
          <input
            type="checkbox"
            checked={cascade}
            onChange={(e) => setCascade(e.target.checked)}
            className="mt-0.5 size-4 rounded border-danger-border text-danger focus:ring-danger-border"
          />
          <span className="text-sm leading-snug">
            <span className="font-medium text-foreground">
              {interpolate(dt.alsoDelete, { parts: partsLabel })}
            </span>
            <span className="block text-xs text-muted-foreground/80 mt-0.5">
              {dt.alsoDeleteDesc}
            </span>
          </span>
        </label>
      ) : (
        <div />
      )}
    </FormModalContent>
  );
}
