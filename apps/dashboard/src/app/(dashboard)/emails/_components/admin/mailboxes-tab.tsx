"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { isManagedMailId } from "@repo/contracts/managed-mail";
import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * Mailboxes tab - list + create/edit/delete for vmail.mailbox rows.
 *
 * Real table layout (DataTable primitive). Always scoped to one domain
 * via the picker at the top; default = primary install domain. Active
 * domain mirrors to the URL (`?domain=…`).
 */

import { useEffect, useId, useMemo, useState } from "react";
import {
  getApiErrorMessage,
  mailAdminApi,
  type AdminDomain,
  type AdminMailbox,
} from "@/lib/api";
import { useModal } from "@/context/ModalContext";
import {
  DataTable,
  RowActionsMenu,
  type DataTableColumn,
} from "./_shared/data-table";
import { DomainPicker } from "./_shared/domain-picker";
import { StatusPill } from "./_shared/status-pill";
import {
  Field,
  FormModalContent,
  inputClassName,
} from "./_shared/form-modal-content";
import { useI18n, interpolate } from "@/components/i18n-provider";
import Link from "next/link";
import { UserAvatar } from "@/components/ui/UserAvatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { useMailRailOwnsTabs } from "../../_lib/mail-section";

interface MailboxesTabProps {
  domainsHref?: string;
  serverId: string;
  primaryDomain: string;
  selectedDomain: string;
  onSelectDomain: (domain: string) => void;
}

export function MailboxesTab({
  domainsHref,
  serverId,
  primaryDomain,
  selectedDomain,
  onSelectDomain,
}: MailboxesTabProps) {
  const { showModal, hideModal } = useModal();
  const { t } = useI18n();
  // Heading lives in the page header in mail view — see ../../_lib/mail-section.
  const hoisted = useMailRailOwnsTabs(serverId);
  const [domains, setDomains] = useState<AdminDomain[]>([]);
  const activeDomain = selectedDomain || primaryDomain || domains[0]?.domain || "";
  const [inventory, setInventory] = useState<Awaited<ReturnType<typeof mailAdminApi.mailboxes.list>>>();
  const mailboxes = inventory?.mailboxes ?? [];
  const readOnly = inventory?.readOnly === true;
  const [loadingDomains, setLoadingDomains] = useState(true);
  const [loadingMailboxes, setLoadingMailboxes] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const [revision, refresh] = useState(0);
  useEffect(() => {
    let current = true;
    setInventory(undefined);
    setLoadingMailboxes(!!activeDomain);
    if (activeDomain) {
      setError(null);
      mailAdminApi.mailboxes.list(serverId, activeDomain).then(result => {
        if (current) setInventory(result);
      }).catch(err => {
        if (current) setError(getApiErrorMessage(err, t.emailsAdmin.mailboxes.loadFailed));
      }).finally(() => { if (current) setLoadingMailboxes(false); });
    }
    return () => { current = false; };
  }, [serverId, activeDomain, revision, t.emailsAdmin.mailboxes.loadFailed]);

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
            refresh(n => n + 1);
          }}
        />
      ),
    });
  };

  const openMailboxAction = (row: AdminMailbox, action: "settings" | "password" | "delete") => {
    const cancel = () => hideModal(id);
    const saved = () => {
      cancel();
      refresh((n) => n + 1);
    };
    const id = showModal({
      maxWidth: action === "settings" ? "560px" : "520px",
      showCloseButton: false,
      customContent:
        action === "delete" ? (
          <DeleteMailboxConfirm
            serverId={serverId}
            primaryDomain={primaryDomain}
            row={row}
            onCancel={cancel}
            onDeleted={saved}
          />
        ) : action === "password" ? (
          <ChangeMailboxPassword
            serverId={serverId}
            username={row.username}
            onCancel={cancel}
            onSaved={saved}
          />
        ) : (
          <EditMailboxForm serverId={serverId} row={row} onCancel={cancel} onSaved={saved} />
        ),
    });
  };

  const openRotatePlatform = () => {
    const id = showModal({
      maxWidth: "520px",
      showCloseButton: false,
      customContent: (
        <RotatePlatformMailboxConfirm
          serverId={serverId}
          email={`openship@${primaryDomain}`}
          onCancel={() => hideModal(id)}
          onRotated={() => {
            hideModal(id);
            refresh(n => n + 1);
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
          <UserAvatar name={r.name || r.username} className="bg-info-bg text-info" />
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
      width: "96px",
      cell: (r) => (
        <div className="flex items-center gap-1.5 flex-wrap">
          {r.active ? (
            <StatusPill tone="success">
              {t.emailsAdmin.mailboxes.active}
            </StatusPill>
          ) : (
            <StatusPill tone="neutral">
              {t.emailsAdmin.mailboxes.disabled}
            </StatusPill>
          )}
          {r.username.startsWith("postmaster@") && (
            <StatusPill tone="info">{t.emailsAdmin.mailboxes.postmaster}</StatusPill>
          )}
          {r.isPlatform && (
            <StatusPill tone="info">{t.emailsAdmin.mailboxes.platform}</StatusPill>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div
        className={`flex items-center gap-3 flex-wrap ${hoisted ? "justify-end" : "justify-between"}`}
      >
        {!hoisted && (
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-foreground">{t.emailsAdmin.mailboxes.heading}</h2>
            <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">
              {t.emailsAdmin.mailboxes.description}
            </p>
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {primaryDomain && activeDomain.toLowerCase() === primaryDomain.toLowerCase() && (
            <Button size="sm" variant="secondary" onClick={openRotatePlatform}>
              <UiIcon name="key" />{t.emailsAdmin.mailboxes.rotateAction}
            </Button>
          )}
          {activeDomain && <Button size="sm" disabled={!inventory || readOnly} onClick={openCreate}>
            <UiIcon name="plus" />{t.emailsAdmin.mailboxes.addMailbox}
          </Button>}
        </div>
      </div>

      <DomainPicker
        label={t.emailsAdmin.mailboxes.domainLabel}
        value={activeDomain}
        domains={domains.map((d) => d.domain)}
        onChange={onSelectDomain}
        loading={loadingDomains}
        loadingLabel={t.emailsAdmin.mailboxes.loading}
      >
        {!loadingMailboxes && mailboxes.length > 0 && (
          <span className="ms-auto text-xs text-muted-foreground tabular-nums">
            {interpolate(t.emailsAdmin.mailboxes.activeCount, {
              active: String(mailboxes.filter((m) => m.active).length),
              total: String(mailboxes.length),
            })}
          </span>
        )}
      </DomainPicker>
      {readOnly && <p className="text-sm text-muted-foreground">{t.emailsAdmin.mailboxes.readOnlyServer}</p>}

      {error && (
        <div className="rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={mailboxes}
        rowKey={(r) => r.username}
        loading={loadingDomains || loadingMailboxes}
        rowActionsWidth="7rem"
        rowActions={(row) =>
          row.isPlatform ? null : (
            <RowActionsMenu
              label={interpolate(t.emailsAdmin.shared.rowActions, { name: row.username })}
              triggerText={t.emailsAdmin.mailboxes.manageAction}
              actions={[
                {
                  id: "password",
                  disabled: readOnly,
                  label: t.emailsAdmin.mailboxes.changePassword,
                  icon: <UiIcon name="key" className="size-4" />,
                  onClick: () => openMailboxAction(row, "password"),
                },
                {
                  id: "edit",
                  disabled: readOnly,
                  label: t.emailsAdmin.mailboxes.editAction,
                  icon: <UiIcon name="edit" className="size-4" />,
                  onClick: () => openMailboxAction(row, "settings"),
                },
                { id: "sep", divider: true },
                {
                  id: "delete",
                  disabled: readOnly,
                  label: t.emailsAdmin.mailboxes.deleteAction,
                  icon: <UiIcon name="trash" className="size-4" />,
                  variant: "danger",
                  onClick: () => openMailboxAction(row, "delete"),
                },
              ]}
            />
          )
        }
        empty={{
          icon: "user",
          title: activeDomain ? t.emailsAdmin.mailboxes.emptyTitle : t.emailsAdmin.domains.emptyTitle,
          description: activeDomain ? interpolate(t.emailsAdmin.mailboxes.emptyDesc, { domain: activeDomain }) : t.emailsAdmin.domains.emptyDesc,
          action: !activeDomain && domainsHref ? (
            <Button asChild size="sm" variant="secondary"><Link href={domainsHref} scroll={false}>{t.emailsAdmin.domains.heading}</Link></Button>
          ) : undefined,
        }}
      />
    </div>
  );
}

function RotatePlatformMailboxConfirm({
  serverId,
  email,
  onCancel,
  onRotated,
}: {
  serverId: string;
  email: string;
  onCancel: () => void;
  onRotated: () => void;
}) {
  const { t } = useI18n();

  const submit = async () => {
    try {
      await mailAdminApi.mailboxes.rotatePlatform(serverId);
    } catch (err) {
      throw new Error(getApiErrorMessage(err, t.emailsAdmin.mailboxes.rotateFailed));
    }
    onRotated();
  };

  return (
    <FormModalContent
      title={t.emailsAdmin.mailboxes.rotateTitle}
      description={interpolate(t.emailsAdmin.mailboxes.rotateDescription, { email })}
      submitLabel={t.emailsAdmin.mailboxes.rotateSubmit}
      submittingLabel={t.emailsAdmin.mailboxes.rotateSubmitting}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        {t.emailsAdmin.mailboxes.rotateNote}
      </div>
    </FormModalContent>
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
      <MailboxPasswordField value={password} setPassword={setPassword} label={t.emailsAdmin.mailboxes.create.passwordLabel} />
      <Field label={t.emailsAdmin.mailboxes.create.quotaLabel} hint={isManagedMailId(serverId) ? undefined : t.emailsAdmin.mailboxes.create.quotaHint}>
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

function MailboxPasswordField({
  value,
  setPassword,
  label,
}: {
  value: string;
  setPassword: (value: string) => void;
  label: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const [visible, setVisible] = useState(false);
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
    setVisible(true);
  };

  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (diagnosticFailure) {
      observeCaughtError(
        diagnosticFailure,
        "dashboard/app/(dashboard)/emails/_components/admin/mailboxes-tab",
      );
      /* HTTP fallback */
    }
  };
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          aria-describedby={id + "-hint"}
          minLength={8}
          required
          value={value}
          onChange={(event) => {
            setPassword(event.target.value);
            setCopied(false);
          }}
          className={inputClassName}
        />
        <Button type="button" variant="secondary" size="sm" onClick={generatePassword}>
          <UiIcon name="key" />
          {t.emailsAdmin.mailboxes.create.generate}
        </Button>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <p id={id + "-hint"} className="me-auto text-xs text-muted-foreground">
          {t.emailsAdmin.mailboxes.create.passwordHint}
        </p>
        {value && (
          <>
            <button
              type="button"
              onClick={() => setVisible(!visible)}
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
                <UiIcon name="check" className="size-3.5 text-success" />
              ) : (
                <UiIcon name="copy" className="size-3.5" />
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ChangeMailboxPassword({
  serverId,
  username,
  onCancel,
  onSaved,
}: {
  serverId: string;
  username: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const copy = t.emailsAdmin.mailboxes;
  return (
    <FormModalContent
      title={copy.changePassword}
      description={username}
      submitLabel={copy.changePassword}
      submittingLabel={copy.editForm.submitting}
      disabled={password.length < 8}
      onCancel={onCancel}
      onSubmit={async () => {
        await mailAdminApi.mailboxes.update(serverId, username, { password });
        onSaved();
      }}
    >
      <MailboxPasswordField
        value={password}
        setPassword={setPassword}
        label={copy.editForm.newPasswordLabel}
      />
    </FormModalContent>
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
  const [quotaGB, setQuotaGB] = useState(
    row.quotaMB > 0 ? String(row.quotaMB / 1024) : "",
  );
  const [active, setActive] = useState(row.active);

  const quotaMB = quotaGB ? Math.round(Number(quotaGB) * 1024) : 0;
  const patch = {
    ...(name !== row.name && { name }),
    ...(quotaMB !== row.quotaMB && { quotaMB }),
    ...(active !== row.active && { active }),
  };
  const submit = async () => {
    await mailAdminApi.mailboxes.update(serverId, row.username, patch);
    onSaved();
  };

  return (
    <FormModalContent
      title={interpolate(t.emailsAdmin.mailboxes.editForm.title, { username: row.username })}
      disabled={Object.keys(patch).length === 0}
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
      <Field label={t.emailsAdmin.mailboxes.editForm.quotaLabel} hint={isManagedMailId(serverId) ? undefined : t.emailsAdmin.mailboxes.editForm.quotaHint}>
        <input
          type="number"
          min={0}
          step={0.5}
          value={quotaGB}
          onChange={(e) => setQuotaGB(e.target.value)}
          className={inputClassName}
        />
      </Field>
      <button type="button" onClick={() => setActive(!active)} aria-pressed={active} className="flex w-full items-start gap-3 cursor-pointer p-3 -mx-1 rounded-xl text-start hover:bg-muted/30 transition-colors">
        <Checkbox checked={active} className="pointer-events-none mt-0.5" />
        <span>
          <span className="block text-sm font-medium text-foreground">
            {t.emailsAdmin.mailboxes.editForm.activeLabel}
          </span>
          <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">
            {t.emailsAdmin.mailboxes.editForm.activeDesc}
          </span>
        </span>
      </button>
    </FormModalContent>
  );
}

// ─── Delete confirm ──────────────────────────────────────────────────────────

function DeleteMailboxConfirm({
  serverId,
  primaryDomain,
  row,
  onCancel,
  onDeleted,
}: {
  serverId: string;
  primaryDomain: string;
  row: AdminMailbox;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const [hardDelete, setHardDelete] = useState(false);
  // Hosted lists exclude the worker’s install domain. On an instance, only
  // that domain’s postmaster has the engine’s hard-delete protection.
  const isPostmaster = !isManagedMailId(serverId) && row.username.startsWith("postmaster@") &&
    (!primaryDomain || row.domain.toLowerCase() === primaryDomain.toLowerCase());

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
        <button
          type="button"
          onClick={() => setHardDelete(!hardDelete)}
          aria-pressed={hardDelete}
          className="flex w-full items-start gap-3 cursor-pointer p-3 -mx-1 rounded-xl text-start hover:bg-danger-bg transition-colors"
        >
          <Checkbox checked={hardDelete} tone="destructive" className="pointer-events-none mt-0.5" />
          <span>
            <span className="block text-sm font-medium text-danger">
              {t.emailsAdmin.mailboxes.deleteForm.hardDeleteLabel}
            </span>
            <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">
              {t.emailsAdmin.mailboxes.deleteForm.hardDeleteDesc}
            </span>
          </span>
        </button>
      ) : (
        <div className="rounded-xl border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning">
          {t.emailsAdmin.mailboxes.deleteForm.postmasterNote}
        </div>
      )}
    </FormModalContent>
  );
}
