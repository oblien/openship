"use client";

import { useCallback, useMemo, useState } from "react";
import type {
  SendingIdentityKind,
  SendingIdentityUsage,
  SendingUsageSnapshot,
} from "@repo/contracts/managed-mail";
import { Icon } from "@repo/ui/icons";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/Drawer";
import { Input } from "@/components/ui/input";
import { useScopedResource, useScopedMutation } from "@/hooks/use-scoped-resource";
import { managedMailApi } from "@/lib/api/managed-mail";
import { QuotaRing } from "./sending-usage";
import { Skeleton } from "./_shared/skeleton";

const unusedAllowance: SendingIdentityUsage = { accepted: 0, pending: 0, monthlyCap: null };
export interface SendingLimits {
  lookup(identity: string): SendingIdentityUsage | undefined;
  workspaceLimit?: number;
  loading?: boolean;
  edit?: (identity: string) => void;
  refreshing?: boolean;
}

export function useSendingLimits(
  kind: SendingIdentityKind,
  enabled: boolean,
  workspaceLimit?: number,
  onActivated?: () => void,
) {
  const fetchUsage = useCallback(
    () => (enabled ? managedMailApi.identityUsage(kind) : Promise.resolve(null)),
    [enabled, kind],
  );
  const report = useScopedResource(fetchUsage);
  const [selected, setSelected] = useState<string | null>(null);
  const snapshot = report.data;
  const rows = useMemo(
    () => new Map(snapshot?.usage?.data.map((row) => [row.identity.toLowerCase(), row])),
    [snapshot],
  );
  function lookup(identity: string) {
    if (!snapshot || report.error) return undefined;
    return rows.get(identity.toLowerCase()) ?? unusedAllowance;
  }
  const editable = snapshot?.canEdit && workspaceLimit != null && !report.error;
  const limits: SendingLimits = {
    lookup,
    workspaceLimit,
    loading: enabled && report.loading,
    edit: editable ? setSelected : undefined,
    refreshing: report.refreshing,
  };
  const current = selected && lookup(selected);
  const editor = selected && current && editable && (
    <SendingLimitEditor
      key={selected}
      kind={kind}
      identity={selected}
      usage={current}
      workspaceLimit={workspaceLimit}
      report={snapshot.usage}
      onClose={() => setSelected(null)}
      onApply={async (cap) => {
        await managedMailApi.setCap(kind, selected, cap);
        setSelected(null);
        report.refresh();
        if (!snapshot.usage && cap !== null) onActivated?.();
      }}
    />
  );
  return {
    limits,
    editor,
    refresh: report.refresh,
    error: report.error,
    configured: !!snapshot?.usage,
  };
}

export function SendingLimitSkeleton({ showLabel = true }: { showLabel?: boolean }) {
  return (
    <div aria-busy="true" className="flex min-w-0 items-center gap-2">
      <Skeleton className="m-0.5 size-9 shrink-0 rounded-full border-[3px] border-muted bg-transparent" />
      <div className="min-w-0 space-y-2">
        {showLabel && <Skeleton className="h-2 w-16 max-w-full" />}
        <Skeleton className="h-3 w-20 max-w-full" />
      </div>
    </div>
  );
}

export function SendingLimitRow({
  identity,
  limits,
  kind,
  showLabel = true,
}: {
  identity: string;
  limits: SendingLimits;
  kind: SendingIdentityKind;
  showLabel?: boolean;
}) {
  const { t, locale } = useI18n();
  const c = t.emails.cloudClient;
  if (limits.loading) return <SendingLimitSkeleton showLabel={showLabel} />;
  const usage = limits.lookup(identity);
  const used = usage ? usage.accepted + usage.pending : null;
  const limit = usage?.monthlyCap ?? limits.workspaceLimit;
  const content = (
    <>
      <QuotaRing label={c.monthlySending} used={used} limit={limit} />
      <span className="min-w-0 flex-1">
        {showLabel && <span className="block text-xs text-muted-foreground">{c.monthlySending}</span>}
        <span
          className="text-sm font-medium tabular-nums"
          title={usage?.monthlyCap === null ? c.workspaceAllowance : undefined}
        >
          {usage?.monthlyCap === 0 ? (
            c.sendingBlocked
          ) : (
            <bdi dir="ltr">
              {used?.toLocaleString(locale) ?? "—"}{" "}
              <span className="font-normal text-muted-foreground">
                / {limit?.toLocaleString(locale) ?? "—"}
              </span>
            </bdi>
          )}
        </span>
      </span>
    </>
  );
  const row = "flex items-center gap-2 text-start";
  if (!limits.edit || !usage) return <div className={row}>{content}</div>;
  return (
    <button
      type="button"
      disabled={limits.refreshing}
      onClick={() => limits.edit?.(identity)}
      aria-label={
        kind === "senders"
          ? interpolate(c.editMailboxLimit, { email: identity })
          : c.domainLimit + " · " + identity
      }
      className={
        row +
        " -mx-1 rounded-lg px-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      }
    >
      {content}
      <Icon name="edit" className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

function SendingLimitEditor({
  kind,
  identity,
  usage,
  workspaceLimit,
  report,
  onApply,
  onClose,
}: {
  kind: SendingIdentityKind;
  identity: string;
  usage: SendingIdentityUsage;
  workspaceLimit: number;
  report?: SendingUsageSnapshot["usage"];
  onApply: (cap: number | null) => Promise<unknown> | void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const c = t.emails.cloudClient;
  const { busy, error, execute } = useScopedMutation();
  const [custom, setCustom] = useState(usage.monthlyCap !== null);
  const [input, setInput] = useState(String(usage.monthlyCap ?? workspaceLimit));
  const value = Number(input);
  const valid = /^\d+$/.test(input) && Number.isSafeInteger(value) && value <= workspaceLimit;
  const cap = custom ? (valid ? value : null) : workspaceLimit;
  const canSave = !busy && (!custom || valid) && (custom ? value : null) !== usage.monthlyCap;
  const used = usage.accepted + usage.pending;
  const title = kind === "senders" ? c.mailboxLimit : c.domainLimit;
  const historical = report?.unattributed;
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Drawer
      isOpen
      onClose={close}
      label={title}
      closeLabel={t.emailsAdmin.shared.close}
      width="420px"
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSave) return;
          void execute(() => Promise.resolve(onApply(custom ? value : null)));
        }}
      >
        <header className="px-6 pb-5 pt-7 pe-14">
          <h2 className="text-lg font-semibold">{title}</h2>
          <bdi className="mt-1 block truncate text-sm text-muted-foreground">{identity}</bdi>
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6">
          <div className="flex items-center gap-4 rounded-xl bg-card p-4">
            <QuotaRing large label={c.monthlySending} used={used} limit={cap} />
            <div>
              <p className="text-xs text-muted-foreground">{c.monthlySending}</p>
              <p className="mt-1 font-semibold tabular-nums">
                {cap === 0
                  ? c.sendingBlocked
                  : `${used.toLocaleString(locale)} / ${cap?.toLocaleString(locale) ?? "—"}`}
              </p>
              <p className="text-xs text-muted-foreground">
                {interpolate(c.sentUsage, {
                  used: usage.accepted.toLocaleString(locale),
                  pending: usage.pending.toLocaleString(locale),
                })}
              </p>
            </div>
          </div>
          {report && (
            <p className="text-xs text-muted-foreground">
              {interpolate(c.capWindow, {
                date: new Date(report.resetAt).toLocaleDateString(locale, {
                  timeZone: "UTC",
                  month: "short",
                  day: "numeric",
                }),
              })}
            </p>
          )}
          {historical && historical.accepted + historical.pending > 0 && (
            <p className="text-xs text-muted-foreground">
              {interpolate(c.unattributedUsage, {
                accepted: historical.accepted.toLocaleString(locale),
                pending: historical.pending.toLocaleString(locale),
              })}
            </p>
          )}
          <fieldset disabled={busy} className="space-y-2">
            <legend className="sr-only">{title}</legend>
            {[false, true].map((choice) => (
              <label
                key={String(choice)}
                className="flex cursor-pointer items-center gap-2 rounded-xl border border-border/60 p-3 text-sm has-checked:bg-muted/45"
              >
                <input
                  type="radio"
                  name="sending-limit"
                  className="accent-foreground"
                  checked={custom === choice}
                  onChange={() => setCustom(choice)}
                />
                {choice ? c.customLimit : c.sharedAllowance}
              </label>
            ))}
          </fieldset>
          {custom && (
            <label className="block text-sm font-medium">
              {c.recipientsLabel}
              <Input
                className="mt-2"
                type="number"
                inputMode="numeric"
                min={0}
                max={workspaceLimit}
                step={1}
                required
                disabled={busy}
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                {c.zeroCap}
              </span>
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border/50 p-5">
          <Button type="button" variant="ghost" disabled={busy} onClick={close}>
            {t.emailsAdmin.shared.cancel}
          </Button>
          <Button type="submit" disabled={!canSave}>
            {busy ? t.actions.saving : c.saveLimit}
          </Button>
        </footer>
      </form>
    </Drawer>
  );
}
