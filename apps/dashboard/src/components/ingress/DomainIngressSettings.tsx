"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Switch } from "@/components/ui/Switch";
import { Modal } from "@/components/ui/Modal";
import { ConnectionNotice } from "@/components/shared/ConnectionNotice";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { ingressApi } from "@/lib/api/ingress";
import {
  useResourceScope,
  useScopedResource,
  useScopedMutation,
} from "@/hooks/use-scoped-resource";
import { useDialogFocus } from "@/hooks/useDialogFocus";
export function DomainIngressMenu({
  domainId,
  serverId,
  hostname,
  onChanged,
  actions,
  triggerLabel,
}: {
  domainId: string;
  serverId: string;
  hostname: string;
  onChanged?: () => void;
  actions: MenuAction[];
  triggerLabel: string;
}) {
  const scope = useResourceScope();
  return (
    <ScopedDomainIngress
      key={`${scope}:${domainId}:${serverId}`}
      domainId={domainId}
      serverId={serverId}
      hostname={hostname}
      onChanged={onChanged}
      actions={actions}
      triggerLabel={triggerLabel}
    />
  );
}
function ScopedDomainIngress({
  domainId,
  serverId,
  hostname,
  onChanged,
  actions,
  triggerLabel,
}: {
  domainId: string;
  serverId: string;
  hostname: string;
  onChanged?: () => void;
  actions: MenuAction[];
  triggerLabel: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const resource = useScopedResource(
    useCallback(() => ingressApi.domain(domainId), [domainId]),
    useCallback(
      (host: { status: string } | null) =>
        host && ["pending", "removing"].includes(host.status)
          ? 2500
          : host?.status === "error"
            ? 10000
            : 0,
      [],
    ),
  );
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    const status = resource.data?.status;
    if (previous.current && previous.current !== "ready" && status === "ready") changed.current?.();
    previous.current = status;
  }, [resource.data?.status]);
  return (
    <>
      <DropdownMenu
        actions={[
          ...actions,
          {
            id: "cloudflare-tunnel",
            label: t.ingress.title,
            icon: <Icon name="cloud" className="size-4" />,
            onClick: () => setOpen(true),
          },
        ]}
        align="right"
        triggerLabel={triggerLabel}
      />
      <Modal
        isOpen={open}
        closable={!busy}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        showCloseButton={false}
        width="min(520px, 100%)"
        maxWidth="100%"
      >
        <DomainIngressForm
          onBusyChange={setBusy}
          domainId={domainId}
          serverId={serverId}
          hostname={hostname}
          onClose={() => setOpen(false)}
          onChanged={() => {
            resource.refresh();
            onChanged?.();
          }}
        />
      </Modal>
    </>
  );
}

function DomainIngressForm({
  domainId,
  serverId,
  hostname,
  onClose,
  onChanged,
  onBusyChange,
}: {
  domainId: string;
  serverId: string;
  hostname: string;
  onClose: () => void;
  onChanged?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useI18n(),
    copy = t.ingress,
    id = useId();
  const { dialog, onKeyDown } = useDialogFocus(() => {
    if (!mutation.busy) onClose();
  });
  const resource = useScopedResource(
    useCallback(async () => {
      const [connections, host] = await Promise.all([
        ingressApi.list(),
        ingressApi.domain(domainId),
      ]);
      return { connections, host };
    }, [serverId, domainId]),
    useCallback(
      (value: { host: { status: string } | null }) =>
        value.host && ["pending", "removing"].includes(value.host.status)
          ? 2500
          : value.host?.status === "error"
            ? 10000
            : 0,
      [],
    ),
  );
  const current = resource.data?.host,
    c = resource.data?.connections.find((c) =>
      current ? c.id === current.connectionId : c.serverId === serverId,
    );
  const [protect, setProtect] = useState<boolean | null>(null),
    [policy, setPolicy] = useState<string | null>(null),
    [confirm, setConfirm] = useState(false);
  const effectivePolicy = current ? current.accessPolicyId : c?.defaultAccessPolicyId;
  const protectedHost = protect ?? Boolean(effectivePolicy),
    policyId = policy ?? effectivePolicy ?? "";
  const policies = useScopedResource(
    useCallback(
      () =>
        c && protectedHost
          ? ingressApi.discover({
              credentialId: c.credentialId,
              accountId: c.accountId,
              includePolicies: true,
            })
          : Promise.resolve(null),
      [c?.credentialId, c?.accountId, protectedHost],
    ),
  );
  const mutation = useScopedMutation();
  useEffect(() => {
    onBusyChange?.(mutation.busy);
    return () => onBusyChange?.(false);
  }, [mutation.busy, onBusyChange]);
  async function save(remove = false) {
    if (!c) return;
    const result = await mutation.execute(async () => {
      await ingressApi.setDomain({
        domainId,
        connectionId: remove ? null : c.id,
        accessPolicyId: remove || !protectedHost ? null : policyId,
      });
      return true;
    });
    if (result) {
      setConfirm(false);
      resource.refresh();
      onChanged?.();
      dialog.current?.focus();
    }
  }
  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="p-6 space-y-5 outline-none"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id={`${id}-title`} className="text-lg font-semibold">
            {copy.title}
          </h2>
          <p className="mt-1 break-all text-sm text-muted-foreground">{hostname}</p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          disabled={mutation.busy}
          onClick={onClose}
          aria-label={copy.close}
        >
          <Icon name="close" />
        </Button>
      </div>
      {resource.loading ? (
        <div className="h-24 animate-pulse rounded-xl bg-muted" />
      ) : resource.error ? (
        <ConnectionNotice
          title={copy.unavailable}
          message={copy.statusUnavailable}
          detail={resource.error}
          onRetry={resource.refresh}
        />
      ) : !c ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{copy.noConnection}</p>
          <Button asChild variant="secondary">
            <Link href={`/servers/${serverId}?tab=security`}>{copy.setupServer}</Link>
          </Button>
        </div>
      ) : (
        <>
          <div className="rounded-xl bg-card p-4 space-y-2">
            <p className="text-sm font-medium break-words">{c.name}</p>
            <p role="status" className="text-xs text-muted-foreground">
              {current
                ? (copy.status[current.status as keyof typeof copy.status] ?? copy.status.pending)
                : copy.notConnected}
              {current && current.status !== "ready"
                ? ` · ${copy.phase[current.phase as keyof typeof copy.phase] ?? copy.phase.tunnel}`
                : ""}
            </p>
            {current?.error && (
              <p role="alert" className="text-sm text-warning break-words">
                {current.error}
              </p>
            )}
          </div>
          {c.status !== "ready" && <p className="text-sm text-warning">{copy.finishServer}</p>}
          <div className="flex items-center justify-between gap-3">
            <label className="text-sm font-medium">{copy.protect}</label>
            <Switch
              ariaLabel={copy.protect}
              checked={protectedHost}
              onChange={setProtect}
              disabled={current?.status === "removing"}
            />
          </div>
          {protectedHost && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{copy.protectHint}</p>
              <label htmlFor={`${id}-policy`} className="text-sm font-medium">
                {copy.policy}
              </label>
              <CustomSelect
                id={`${id}-policy`}
                variant="filled"
                triggerClassName="bg-muted/60 hover:bg-muted"
                value={policyId}
                onChange={setPolicy}
                options={(policies.data?.policies ?? []).map((p) => ({
                  value: p.id,
                  label: p.name,
                }))}
                placeholder={copy.choose}
                disabled={policies.loading || current?.status === "removing"}
              />
              {(policies.error || policies.data?.policiesError) && (
                <p role="alert" className="text-sm text-danger">
                  {policies.error ?? policies.data?.policiesError}
                  <Button variant="ghost" onClick={policies.refresh}>
                    {copy.refresh}
                  </Button>
                </p>
              )}
            </div>
          )}
          {mutation.error && (
            <p role="alert" className="text-sm text-danger">
              {mutation.error}
            </p>
          )}
          {confirm ? (
            <div className="rounded-xl bg-warning/10 p-4 space-y-3">
              <p className="text-sm">{copy.disconnectDomainHint}</p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" disabled={mutation.busy} onClick={() => setConfirm(false)}>
                  {copy.cancel}
                </Button>
                <Button
                  variant="destructive"
                  disabled={mutation.busy}
                  onClick={() => void save(true)}
                >
                  {copy.disconnect}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {current && (
                <Button
                  variant="ghost"
                  onClick={() => setConfirm(true)}
                  disabled={mutation.busy || current.status === "removing"}
                >
                  {copy.disconnect}
                </Button>
              )}
              <Button
                onClick={() => void save()}
                disabled={
                  mutation.busy ||
                  c.status !== "ready" ||
                  c.serverId !== serverId ||
                  current?.status === "removing" ||
                  (protectedHost && !policyId)
                }
              >
                {mutation.busy ? (
                  <Icon name="spinner" className="animate-spin" />
                ) : (
                  <Icon name="check" />
                )}
                {current?.status === "error"
                  ? copy.retry
                  : current
                    ? copy.save
                    : copy.connectDomain}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
export function IngressDestinationNotice({ serverId }: { serverId?: string | null }) {
  const { t } = useI18n();
  const resource = useScopedResource(
    useCallback(() => (serverId ? ingressApi.list(serverId) : Promise.resolve([])), [serverId]),
  );
  const connection = resource.data?.find((c) => c.defaultForDomains && c.status !== "removing");
  if (resource.error)
    return (
      <ConnectionNotice
        compact
        title={t.ingress.unavailable}
        message={t.ingress.statusUnavailable}
        detail={resource.error}
        onRetry={resource.refresh}
      />
    );
  if (!connection) return null;
  return (
    <div className="flex items-start gap-3 rounded-xl bg-card p-4 text-sm">
      <Icon name="cloud" className="mt-0.5 size-4 shrink-0" />
      <div>
        <p className="font-medium">{t.ingress.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t.ingress.autoEnabled}
          {connection.defaultAccessPolicyId ? ` ${t.ingress.defaultProtected}` : ""}
        </p>
        <Link
          className="mt-2 inline-flex text-xs underline underline-offset-4"
          href={`/servers/${serverId}?tab=security`}
        >
          {t.ingress.setupServer}
        </Link>
      </div>
    </div>
  );
}
