"use client";

/**
 * Mailboxes tab - list + create/edit/delete for vmail.mailbox rows.
 *
 * Real table layout (DataTable primitive). Always scoped to one domain
 * via the picker at the top; default = primary install domain. Active
 * domain mirrors to the URL (`?domain=…`).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  UserRound,
} from "lucide-react";
import {
  getApiErrorMessage,
  mailAdminApi,
  type AdminDomain,
  type AdminMailbox,
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

interface MailboxesTabProps {
  serverId: string;
  primaryDomain: string;
  selectedDomain: string;
  onSelectDomain: (domain: string) => void;
}

export function MailboxesTab({
  serverId,
  primaryDomain,
  selectedDomain,
  onSelectDomain,
}: MailboxesTabProps) {
  const { showModal, hideModal } = useModal();
  const { t } = useI18n();
  const [domains, setDomains] = useState<AdminDomain[]>([]);
  const [mailboxes, setMailboxes] = useState<AdminMailbox[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(true);
  const [loadingMailboxes, setLoadingMailboxes] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const activeDomain = selectedDomain || primaryDomain;
  const activeDomainRow = useMemo(
    () => domains.find((d) => d.domain === activeDomain),
    [domains, activeDomain],
  );

  useEffect(() => {
    let cancelled = false;
    setLoadingDomains(true);
    mailAdminApi.domains
      .list(serverId)
      .then((res) => {
        if (cancelled) return;
        setDomains(res.domains);
        // If the URL points at a domain that no longer exists (e.g. it
        // was just deleted from the Domains tab), bounce back to the
        // primary domain so the mailbox fetch below doesn't 4xx in a
        // loop.
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
        setError(getApiErrorMessage(err, t.emailsAdmin.mailboxes.loadDomainsFailed));
      })
      .finally(() => {
        if (!cancelled) setLoadingDomains(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, selectedDomain, primaryDomain, onSelectDomain]);

  const reloadMailboxes = useCallback(async () => {
    if (!activeDomain) return;
    setLoadingMailboxes(true);
    setError(null);
    try {
      const res = await mailAdminApi.mailboxes.list(serverId, activeDomain);
      setMailboxes(res.mailboxes);
    } catch (err) {
      setError(getApiErrorMessage(err, t.emailsAdmin.mailboxes.loadFailed));
    } finally {
      setLoadingMailboxes(false);
    }
  }, [serverId, activeDomain]);

  useEffect(() => {
    void reloadMailboxes();
  }, [reloadMailboxes]);

  const openCreate = () => {
    if (!activeDomain) return;
    const id = showModal({
      maxWidth: "560px",
      showCloseButton: false,
      customContent: (
        <CreateMailboxForm
          serverId={serverId}
          domain={activeDomain}
          defaultQuotaMB={activeDomainRow?.defaultQuotaMB ?? 0}
          onCancel={() => hideModal(id)}
          onCreated={() => {
            hideModal(id);
            void reloadMailboxes();
          }}
        />
      ),
    });
  };

  const openEdit = (row: AdminMailbox) => {
    const id = showModal({
      maxWidth: "560px",
      showCloseButton: false,
      customContent: (
        <EditMailboxForm
          serverId={serverId}
          row={row}
          onCancel={() => hideModal(id)}
          onSaved={() => {
            hideModal(id);
            void reloadMailboxes();
          }}
        />
      ),
    });
  };

  const openDelete = (row: AdminMailbox) => {
    const id = showModal({
      maxWidth: "520px",
      showCloseButton: false,
      customContent: (
        <DeleteMailboxConfirm
          serverId={serverId}
          row={row}
          onCancel={() => hideModal(id)}
          onDeleted={() => {
            hideModal(id);
            void reloadMailboxes();
          }}
        />
      ),
    });
  };

  const columns: DataTableColumn<AdminMailbox>[] = [
    {
      key: "user",
      header: t.emailsAdmin.mailboxes.colMailbox,
      width: "minmax(240px, 2fr)",
      cell: (r) => (
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
            <UserRound
              className="size-4 text-muted-foreground"
              strokeWidth={2}
            />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate">
              {r.name || r.username.split("@")[0]}
            </p>
            <p className="text-xs text-muted-foreground truncate mt-0.5 font-mono">
              {r.username}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: "quota",
      header: t.emailsAdmin.mailboxes.colQuota,
      width: "120px",
      align: "right",
      hideBelow: "md",
      cell: (r) => (
        <span className="text-sm text-foreground tabular-nums">
          {r.quotaMB === 0 ? (
            <span className="text-muted-foreground">{t.emailsAdmin.mailboxes.unlimited}</span>
          ) : (
            formatQuota(r.quotaMB)
          )}
        </span>
      ),
    },
    {
      key: "status",
      header: t.emailsAdmin.mailboxes.colStatus,
      width: "180px",
      cell: (r) => (
        <div className="flex items-center gap-1.5 flex-wrap">
          {r.active ? (
            <StatusPill tone="success" dot>
              {t.emailsAdmin.mailboxes.active}
            </StatusPill>
          ) : (
            <StatusPill tone="neutral" dot>
              {t.emailsAdmin.mailboxes.disabled}
            </StatusPill>
          )}
          {r.username.startsWith("postmaster@") && (
            <StatusPill tone="info">{t.emailsAdmin.mailboxes.postmaster}</StatusPill>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{t.emailsAdmin.mailboxes.heading}</h2>
          <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">
            {t.emailsAdmin.mailboxes.description}
          </p>
        </div>
        <button
          onClick={openCreate}
          disabled={!activeDomain}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 disabled:opacity-50 disabled:hover:shadow-none shrink-0"
        >
          <Plus className="size-4" />
          {t.emailsAdmin.mailboxes.addMailbox}
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-muted-foreground">{t.emailsAdmin.mailboxes.domainLabel}</span>
        {loadingDomains ? (
          <div className="px-3 py-2 rounded-xl border border-border bg-muted/30 flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{t.emailsAdmin.mailboxes.loading}</span>
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
        {!loadingMailboxes && mailboxes.length > 0 && (
          <span className="ms-auto text-xs text-muted-foreground tabular-nums">
            {interpolate(t.emailsAdmin.mailboxes.activeCount, {
              active: String(mailboxes.filter((m) => m.active).length),
              total: String(mailboxes.length),
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
        rows={mailboxes}
        rowKey={(r) => r.username}
        loading={loadingMailboxes}
        rowActions={(row) => (
          <>
            <RowIconButton
              icon={Pencil}
              label={t.emailsAdmin.mailboxes.editAction}
              onClick={() => openEdit(row)}
            />
            <RowIconButton
              icon={Trash2}
              label={t.emailsAdmin.mailboxes.deleteAction}
              variant="danger"
              onClick={() => openDelete(row)}
            />
          </>
        )}
        empty={{
          icon: UserRound,
          title: t.emailsAdmin.mailboxes.emptyTitle,
          description: interpolate(t.emailsAdmin.mailboxes.emptyDesc, { domain: activeDomain }),
          action: (
            <button
              onClick={openCreate}
              disabled={!activeDomain}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              <Plus className="size-4" />
              {t.emailsAdmin.mailboxes.addMailbox}
            </button>
          ),
        }}
      />
    </div>
  );
}

function formatQuota(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

// ─── Create form ─────────────────────────────────────────────────────────────

function CreateMailboxForm({
  serverId,
  domain,
  defaultQuotaMB,
  onCancel,
  onCreated,
}: {
  serverId: string;
  domain: string;
  defaultQuotaMB: number;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [localPart, setLocalPart] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [quotaGB, setQuotaGB] = useState(
    defaultQuotaMB > 0 ? String(defaultQuotaMB / 1024) : "",
  );
  const [showPassword, setShowPassword] = useState(false);

  const submit = async () => {
    await mailAdminApi.mailboxes.create(serverId, {
      localPart: localPart.trim().toLowerCase(),
      domain,
      password,
      name: name.trim() || undefined,
      quotaMB: quotaGB ? Math.round(Number(quotaGB) * 1024) : 0,
    });
    onCreated();
  };

  const generatePassword = () => {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    setPassword(
      btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "0")
        .replace(/\//g, "1")
        .replace(/=/g, "")
        .slice(0, 20),
    );
    setShowPassword(true);
  };

  return (
    <FormModalContent
      title={interpolate(t.emailsAdmin.mailboxes.create.title, { domain })}
      description={t.emailsAdmin.mailboxes.create.description}
      submitLabel={t.emailsAdmin.mailboxes.create.submit}
      submittingLabel={t.emailsAdmin.mailboxes.create.submitting}
      onSubmit={submit}
      onCancel={onCancel}
      disabled={!localPart.trim() || password.length < 8}
    >
      <Field label={t.emailsAdmin.mailboxes.create.localPartLabel} hint={t.emailsAdmin.mailboxes.create.localPartHint}>
        <div className="flex items-stretch rounded-xl border border-border bg-background focus-within:ring-2 focus-within:ring-primary/40 focus-within:border-primary/60 transition-colors">
          <input
            type="text"
            autoFocus
            value={localPart}
            onChange={(e) => setLocalPart(e.target.value)}
            placeholder="alice"
            className="flex-1 px-3 py-2 text-sm bg-transparent text-foreground placeholder:text-muted-foreground/60 focus:outline-none rounded-s-xl"
          />
          <span className="px-3 py-2 text-sm text-muted-foreground border-s border-border bg-muted/40 rounded-e-xl whitespace-nowrap">
            @{domain}
          </span>
        </div>
      </Field>
      <Field label={t.emailsAdmin.mailboxes.create.fullNameLabel} hint={t.emailsAdmin.mailboxes.create.fullNameHint}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Alice Carter"
          className={inputClassName}
        />
      </Field>
      <Field label={t.emailsAdmin.mailboxes.create.passwordLabel} hint={t.emailsAdmin.mailboxes.create.passwordHint}>
        <div className="flex gap-2">
          <input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClassName}
          />
          <button
            type="button"
            onClick={generatePassword}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-xl bg-muted text-foreground hover:bg-muted/80 border border-border transition-colors whitespace-nowrap"
          >
            <KeyRound className="size-3.5" />
            {t.emailsAdmin.mailboxes.create.generate}
          </button>
        </div>
        {password && (
          <PasswordPreview
            value={password}
            visible={showPassword}
            onToggle={() => setShowPassword((v) => !v)}
          />
        )}
      </Field>
      <Field label={t.emailsAdmin.mailboxes.create.quotaLabel} hint={t.emailsAdmin.mailboxes.create.quotaHint}>
        <input
          type="number"
          min={0}
          step={0.5}
          value={quotaGB}
          onChange={(e) => setQuotaGB(e.target.value)}
          placeholder="5"
          className={inputClassName}
        />
      </Field>
    </FormModalContent>
  );
}

function PasswordPreview({
  value,
  visible,
  onToggle,
}: {
  value: string;
  visible: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* HTTP fallback */
    }
  };
  return (
    <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded-xl bg-muted/40 border border-border/50">
      <span className="text-[13px] text-foreground flex-1 truncate">
        {visible ? value : "•".repeat(Math.min(value.length, 24))}
      </span>
      <button
        type="button"
        onClick={onToggle}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        {visible ? t.emailsAdmin.mailboxes.create.hide : t.emailsAdmin.mailboxes.create.show}
      </button>
      <button
        type="button"
        onClick={copy}
        className="p-1 text-muted-foreground hover:text-foreground"
        title={t.emailsAdmin.mailboxes.create.copy}
        aria-label={t.emailsAdmin.mailboxes.create.copyPassword}
      >
        {copied ? (
          <Check className="size-3.5 text-success" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </div>
  );
}

// ─── Edit form ───────────────────────────────────────────────────────────────

function EditMailboxForm({
  serverId,
  row,
  onCancel,
  onSaved,
}: {
  serverId: string;
  row: AdminMailbox;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(row.name);
  const [password, setPassword] = useState("");
  const [quotaGB, setQuotaGB] = useState(
    row.quotaMB > 0 ? String(row.quotaMB / 1024) : "",
  );
  const [active, setActive] = useState(row.active);

  const submit = async () => {
    await mailAdminApi.mailboxes.update(serverId, row.username, {
      name,
      password: password ? password : undefined,
      quotaMB: quotaGB ? Math.round(Number(quotaGB) * 1024) : 0,
      active,
    });
    onSaved();
  };

  return (
    <FormModalContent
      title={interpolate(t.emailsAdmin.mailboxes.editForm.title, { username: row.username })}
      submitLabel={t.emailsAdmin.mailboxes.editForm.submit}
      submittingLabel={t.emailsAdmin.mailboxes.editForm.submitting}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <Field label={t.emailsAdmin.mailboxes.editForm.fullNameLabel}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClassName}
        />
      </Field>
      <Field
        label={t.emailsAdmin.mailboxes.editForm.newPasswordLabel}
        hint={t.emailsAdmin.mailboxes.editForm.newPasswordHint}
      >
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className={inputClassName}
        />
      </Field>
      <Field label={t.emailsAdmin.mailboxes.editForm.quotaLabel} hint={t.emailsAdmin.mailboxes.editForm.quotaHint}>
        <input
          type="number"
          min={0}
          step={0.5}
          value={quotaGB}
          onChange={(e) => setQuotaGB(e.target.value)}
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
            {t.emailsAdmin.mailboxes.editForm.activeLabel}
          </span>
          <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">
            {t.emailsAdmin.mailboxes.editForm.activeDesc}
          </span>
        </span>
      </label>
    </FormModalContent>
  );
}

// ─── Delete confirm ──────────────────────────────────────────────────────────

function DeleteMailboxConfirm({
  serverId,
  row,
  onCancel,
  onDeleted,
}: {
  serverId: string;
  row: AdminMailbox;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const [hardDelete, setHardDelete] = useState(false);
  const isPostmaster = row.username.startsWith("postmaster@");

  const submit = async () => {
    if (hardDelete && !isPostmaster) {
      await mailAdminApi.mailboxes.hardDelete(serverId, row.username);
    } else {
      await mailAdminApi.mailboxes.softDelete(serverId, row.username);
    }
    onDeleted();
  };

  return (
    <FormModalContent
      title={interpolate(t.emailsAdmin.mailboxes.deleteForm.title, { username: row.username })}
      description={
        hardDelete
          ? t.emailsAdmin.mailboxes.deleteForm.descHard
          : t.emailsAdmin.mailboxes.deleteForm.descSoft
      }
      submitLabel={hardDelete ? t.emailsAdmin.mailboxes.deleteForm.submitHard : t.emailsAdmin.mailboxes.deleteForm.submitSoft}
      submittingLabel={t.emailsAdmin.mailboxes.deleteForm.submitting}
      submitVariant="danger"
      onSubmit={submit}
      onCancel={onCancel}
    >
      {!isPostmaster ? (
        <label className="flex items-start gap-3 cursor-pointer p-3 -mx-1 rounded-xl hover:bg-danger-bg transition-colors">
          <input
            type="checkbox"
            checked={hardDelete}
            onChange={(e) => setHardDelete(e.target.checked)}
            className="rounded border-border mt-0.5"
          />
          <span>
            <span className="block text-sm font-medium text-danger">
              {t.emailsAdmin.mailboxes.deleteForm.hardDeleteLabel}
            </span>
            <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">
              {t.emailsAdmin.mailboxes.deleteForm.hardDeleteDesc}
            </span>
          </span>
        </label>
      ) : (
        <div className="rounded-xl border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning">
          {t.emailsAdmin.mailboxes.deleteForm.postmasterNote}
        </div>
      )}
    </FormModalContent>
  );
}
