"use client";

/**
 * Aliases tab - list + create/delete/toggle for vmail.forwardings rows with
 * is_alias = 1 (per-address forwards and domain catch-alls). Mailbox
 * self-forwarding rows (is_forwarding = 1) live in the Mailboxes tab, not
 * here - see aliases.service.ts on the API side for the split.
 *
 * Same real-table layout as Mailboxes (DataTable primitive), scoped to one
 * domain via the picker at the top. Unlike Mailboxes, the create dialog has
 * its own domain select so an alias for any domain can be added without
 * leaving the current view.
 */

import { useCallback, useEffect, useState } from "react";
import { Forward, Plus, Power, Trash2 } from "lucide-react";
import {
  getApiErrorMessage,
  mailAdminApi,
  type AdminAlias,
  type AdminDomain,
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
import { useI18n, interpolate } from "@/components/i18n-provider";

interface AliasesTabProps {
  serverId: string;
  primaryDomain: string;
  selectedDomain: string;
  onSelectDomain: (domain: string) => void;
}

export function AliasesTab({
  serverId,
  primaryDomain,
  selectedDomain,
  onSelectDomain,
}: AliasesTabProps) {
  const { showModal, hideModal } = useModal();
  const { t } = useI18n();
  const [domains, setDomains] = useState<AdminDomain[]>([]);
  const [aliases, setAliases] = useState<AdminAlias[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(true);
  const [loadingAliases, setLoadingAliases] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const activeDomain = selectedDomain || primaryDomain;

  useEffect(() => {
    let cancelled = false;
    setLoadingDomains(true);
    mailAdminApi.domains
      .list(serverId)
      .then((res) => {
        if (cancelled) return;
        setDomains(res.domains);
        if (
          selectedDomain &&
          selectedDomain !== primaryDomain &&
          !res.domains.some((d) => d.domain === selectedDomain)
        ) {
          onSelectDomain(primaryDomain);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(getApiErrorMessage(err, t.emailsAdmin.aliases.loadDomainsFailed));
      })
      .finally(() => {
        if (!cancelled) setLoadingDomains(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, selectedDomain, primaryDomain, onSelectDomain]);

  const reloadAliases = useCallback(async () => {
    if (!activeDomain) return;
    setLoadingAliases(true);
    setError(null);
    try {
      const res = await mailAdminApi.aliases.list(serverId, activeDomain);
      setAliases(res.aliases);
    } catch (err) {
      setError(getApiErrorMessage(err, t.emailsAdmin.aliases.loadFailed));
    } finally {
      setLoadingAliases(false);
    }
  }, [serverId, activeDomain]);

  useEffect(() => {
    void reloadAliases();
  }, [reloadAliases]);

  const openCreate = () => {
    const id = showModal({
      maxWidth: "560px",
      showCloseButton: false,
      customContent: (
        <CreateAliasForm
          serverId={serverId}
          domains={domains}
          defaultDomain={activeDomain}
          onCancel={() => hideModal(id)}
          onCreated={() => {
            hideModal(id);
            void reloadAliases();
          }}
        />
      ),
    });
  };

  const openDelete = (row: AdminAlias) => {
    const id = showModal({
      maxWidth: "520px",
      showCloseButton: false,
      customContent: (
        <DeleteAliasConfirm
          serverId={serverId}
          row={row}
          onCancel={() => hideModal(id)}
          onDeleted={() => {
            hideModal(id);
            void reloadAliases();
          }}
        />
      ),
    });
  };

  const toggleActive = async (row: AdminAlias) => {
    setError(null);
    try {
      await mailAdminApi.aliases.setActive(serverId, row.id, !row.active);
      void reloadAliases();
    } catch (err) {
      setError(getApiErrorMessage(err, t.emailsAdmin.aliases.loadFailed));
    }
  };

  const columns: DataTableColumn<AdminAlias>[] = [
    {
      key: "source",
      header: t.emailsAdmin.aliases.colSource,
      width: "minmax(220px, 1.4fr)",
      cell: (r) => (
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
            <Forward className="size-4 text-muted-foreground" strokeWidth={2} />
          </div>
          <p className="text-sm font-medium text-foreground truncate font-mono">
            {r.isCatchAll ? `*@${r.address}` : r.address}
          </p>
        </div>
      ),
    },
    {
      key: "destination",
      header: t.emailsAdmin.aliases.colDestination,
      width: "minmax(200px, 1.2fr)",
      cell: (r) => (
        <span className="text-sm text-foreground font-mono truncate">{r.forwarding}</span>
      ),
    },
    {
      key: "type",
      header: t.emailsAdmin.aliases.colType,
      width: "140px",
      hideBelow: "md",
      cell: (r) => (
        <StatusPill tone={r.isCatchAll ? "info" : "neutral"}>
          {r.isCatchAll ? t.emailsAdmin.aliases.typeCatchAll : t.emailsAdmin.aliases.typeAlias}
        </StatusPill>
      ),
    },
    {
      key: "status",
      header: t.emailsAdmin.aliases.colStatus,
      width: "140px",
      cell: (r) =>
        r.active ? (
          <StatusPill tone="success" dot>
            {t.emailsAdmin.aliases.active}
          </StatusPill>
        ) : (
          <StatusPill tone="neutral" dot>
            {t.emailsAdmin.aliases.disabled}
          </StatusPill>
        ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{t.emailsAdmin.aliases.heading}</h2>
          <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">
            {t.emailsAdmin.aliases.description}
          </p>
        </div>
        <button
          onClick={openCreate}
          disabled={domains.length === 0}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 disabled:opacity-50 disabled:hover:shadow-none shrink-0"
        >
          <Plus className="size-4" />
          {t.emailsAdmin.aliases.addAlias}
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-muted-foreground">{t.emailsAdmin.aliases.domainLabel}</span>
        {loadingDomains ? (
          <div className="px-3 py-2 rounded-xl border border-border bg-muted/30 flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t.emailsAdmin.aliases.loading}</span>
          </div>
        ) : (
          <select
            value={activeDomain}
            onChange={(e) => onSelectDomain(e.target.value)}
            className="px-3 py-2 text-sm rounded-xl border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors min-w-[200px]"
          >
            {domains.map((d) => (
              <option key={d.domain} value={d.domain}>
                {d.domain}
              </option>
            ))}
          </select>
        )}
        {!loadingAliases && aliases.length > 0 && (
          <span className="ms-auto text-xs text-muted-foreground tabular-nums">
            {interpolate(t.emailsAdmin.aliases.activeCount, {
              active: String(aliases.filter((a) => a.active).length),
              total: String(aliases.length),
            })}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={aliases}
        rowKey={(r) => String(r.id)}
        loading={loadingAliases}
        rowActions={(row) => (
          <>
            <RowIconButton
              icon={Power}
              label={row.active ? t.emailsAdmin.aliases.deactivateAction : t.emailsAdmin.aliases.activateAction}
              onClick={() => void toggleActive(row)}
            />
            <RowIconButton
              icon={Trash2}
              label={t.emailsAdmin.aliases.deleteAction}
              variant="danger"
              onClick={() => openDelete(row)}
            />
          </>
        )}
        empty={{
          icon: Forward,
          title: t.emailsAdmin.aliases.emptyTitle,
          description: interpolate(t.emailsAdmin.aliases.emptyDesc, { domain: activeDomain }),
          action: (
            <button
              onClick={openCreate}
              disabled={domains.length === 0}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              <Plus className="size-4" />
              {t.emailsAdmin.aliases.addAlias}
            </button>
          ),
        }}
      />
    </div>
  );
}

// ─── Create form ─────────────────────────────────────────────────────────────

function CreateAliasForm({
  serverId,
  domains,
  defaultDomain,
  onCancel,
  onCreated,
}: {
  serverId: string;
  domains: AdminDomain[];
  defaultDomain: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [domain, setDomain] = useState(defaultDomain);
  const [isCatchAll, setIsCatchAll] = useState(false);
  const [localPart, setLocalPart] = useState("");
  const [destination, setDestination] = useState("");

  const submit = async () => {
    try {
      await mailAdminApi.aliases.create(serverId, {
        domain,
        localPart: isCatchAll ? undefined : localPart.trim().toLowerCase(),
        isCatchAll,
        destination: destination.trim().toLowerCase(),
      });
      onCreated();
    } catch (err) {
      // ApiError.message is just "API 409: Conflict" - the server's actual
      // error string (e.g. AliasConflictsWithMailboxError's message) lives
      // in the response body, which only getApiErrorMessage unwraps.
      // FormModalContent's own catch just does `err.message`, so re-throw a
      // plain Error carrying the unwrapped text.
      throw new Error(getApiErrorMessage(err, t.emailsAdmin.aliases.loadFailed));
    }
  };

  const canSubmit =
    Boolean(domain) &&
    Boolean(destination.trim()) &&
    (isCatchAll || Boolean(localPart.trim()));

  return (
    <FormModalContent
      title={interpolate(t.emailsAdmin.aliases.create.title, { domain: domain || "…" })}
      description={t.emailsAdmin.aliases.create.description}
      submitLabel={t.emailsAdmin.aliases.create.submit}
      submittingLabel={t.emailsAdmin.aliases.create.submitting}
      onSubmit={submit}
      onCancel={onCancel}
      disabled={!canSubmit}
    >
      <Field label={t.emailsAdmin.aliases.domainLabel}>
        <select
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          className={inputClassName}
        >
          {domains.map((d) => (
            <option key={d.domain} value={d.domain}>
              {d.domain}
            </option>
          ))}
        </select>
      </Field>

      <label className="flex items-start gap-3 cursor-pointer p-3 -mx-1 rounded-xl hover:bg-muted/30 transition-colors">
        <input
          type="checkbox"
          checked={isCatchAll}
          onChange={(e) => setIsCatchAll(e.target.checked)}
          className="rounded border-border mt-0.5"
        />
        <span>
          <span className="block text-sm font-medium text-foreground">
            {t.emailsAdmin.aliases.create.catchAllLabel}
          </span>
          <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">
            {interpolate(t.emailsAdmin.aliases.create.catchAllHint, { domain: domain || "…" })}
          </span>
        </span>
      </label>

      {!isCatchAll && (
        <Field
          label={t.emailsAdmin.aliases.create.localPartLabel}
          hint={t.emailsAdmin.aliases.create.localPartHint}
        >
          <div className="flex items-stretch rounded-xl border border-border bg-background focus-within:ring-2 focus-within:ring-primary/40 focus-within:border-primary/60 transition-colors">
            <input
              type="text"
              autoFocus
              value={localPart}
              onChange={(e) => setLocalPart(e.target.value)}
              placeholder="shop"
              className="flex-1 px-3 py-2 text-sm bg-transparent text-foreground placeholder:text-muted-foreground/60 focus:outline-none rounded-s-xl"
            />
            <span className="px-3 py-2 text-sm text-muted-foreground border-s border-border bg-muted/40 rounded-e-xl whitespace-nowrap">
              @{domain || "…"}
            </span>
          </div>
        </Field>
      )}

      <Field
        label={t.emailsAdmin.aliases.create.destinationLabel}
        hint={t.emailsAdmin.aliases.create.destinationHint}
      >
        <input
          type="email"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="you@gmail.com"
          className={inputClassName}
        />
      </Field>
    </FormModalContent>
  );
}

// ─── Delete confirm ──────────────────────────────────────────────────────────

function DeleteAliasConfirm({
  serverId,
  row,
  onCancel,
  onDeleted,
}: {
  serverId: string;
  row: AdminAlias;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const source = row.isCatchAll
    ? interpolate(t.emailsAdmin.aliases.deleteForm.sourceCatchAll, { domain: row.domain })
    : row.address;

  const submit = async () => {
    await mailAdminApi.aliases.delete(serverId, row.id);
    onDeleted();
  };

  return (
    <FormModalContent
      title={t.emailsAdmin.aliases.deleteForm.title}
      description={interpolate(t.emailsAdmin.aliases.deleteForm.description, {
        source,
      })}
      submitLabel={t.emailsAdmin.aliases.deleteForm.submit}
      submittingLabel={t.emailsAdmin.aliases.deleteForm.submitting}
      submitVariant="danger"
      onSubmit={submit}
      onCancel={onCancel}
    >
      <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground font-mono">
        {source} → {row.forwarding}
      </div>
    </FormModalContent>
  );
}
