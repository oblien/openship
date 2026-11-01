"use client";
import { useCallback, useState } from "react";
import type { IngressConnection } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { ConnectionNotice } from "@/components/shared/ConnectionNotice";
import { authClient } from "@/lib/auth-client";
import { ingressApi } from "@/lib/api/ingress";
import {
  useResourceScope,
  useScopedResource,
  useScopedMutation,
} from "@/hooks/use-scoped-resource";
import { IngressPreferences } from "./IngressPreferences";
import { IngressConnectForm } from "./IngressConnectForm";
const polling = (rows: IngressConnection[]) =>
  rows.some((c) => c.status === "pending" || c.status === "removing")
    ? 2500
    : rows.some((c) => c.status === "error")
      ? 10000
      : 0;
export function ServerIngressCard({ serverId }: { serverId: string }) {
  const scope = useResourceScope();
  return <ServerIngressContent key={`${scope}:${serverId}`} serverId={serverId} />;
}
function ServerIngressContent({ serverId }: { serverId: string }) {
  const { t } = useI18n(),
    copy = t.ingress;
  const resource = useScopedResource(
    useCallback(() => ingressApi.list(serverId), [serverId]),
    polling,
  );
  const role = useScopedResource(
    useCallback(async () => {
      const result = await authClient.organization.getActiveMemberRole();
      if (result.error) throw new Error(result.error.message);
      return result.data?.role ?? "";
    }, []),
  );
  const admin = ["admin", "owner"].includes(role.data ?? "");
  const [open, setOpen] = useState(false),
    [confirm, setConfirm] = useState(false),
    [preferences, setPreferences] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const mutation = useScopedMutation(),
    current = resource.data?.[0];
  async function retry() {
    if (current && (await mutation.execute(() => ingressApi.retry(current.id)))) resource.refresh();
  }
  async function remove() {
    if (current && (await mutation.execute(() => ingressApi.disconnect(current.id)))) {
      setConfirm(false);
      resource.refresh();
    }
  }
  return (
    <section className="rounded-2xl bg-card p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-muted p-2.5">
            <Icon name="cloud" className="size-5" />
          </span>
          <div>
            <h2 className="text-base font-medium">{copy.title}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{copy.description}</p>
          </div>
        </div>
        {current && !resource.error && !resource.loading && (
          <Button variant="ghost" size="icon" onClick={resource.refresh} aria-label={copy.refresh}>
            <Icon name="refresh" />
          </Button>
        )}
      </div>
      {resource.loading ? (
        <div className="h-20 animate-pulse rounded-xl bg-muted" aria-label={copy.loading} />
      ) : resource.error ? (
        <ConnectionNotice
          title={copy.unavailable}
          retryLabel={copy.refresh}
          message={copy.statusUnavailable}
          detail={resource.error}
          onRetry={resource.refresh}
        />
      ) : current ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card p-4">
            <div className="min-w-0">
              <p className="break-words text-sm font-medium">{current.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {current.connector === "managed" ? copy.managedConnector : copy.existingConnector}
              </p>
            </div>
            <span
              role="status"
              className={`inline-flex items-center gap-2 text-xs ${current.status === "ready" ? "text-success" : current.status === "error" ? "text-warning" : "text-muted-foreground"}`}
            >
              <Icon
                name={
                  current.status === "ready"
                    ? "check"
                    : current.status === "error"
                      ? "warning"
                      : "spinner"
                }
                className={`size-4 ${["pending", "removing"].includes(current.status) ? "animate-spin" : ""}`}
              />
              {copy.status[current.status as keyof typeof copy.status] ?? copy.status.pending}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {current.defaultForDomains ? copy.autoEnabled : copy.autoDisabled}
            {current.defaultAccessPolicyId ? ` ${copy.defaultProtected}` : ""}
          </p>
          {current.error && (
            <p
              role="alert"
              className="rounded-xl bg-warning/10 p-3 text-sm text-warning break-words"
            >
              {current.error}
            </p>
          )}
          {mutation.error && (
            <p role="alert" className="text-sm text-danger">
              {mutation.error}
            </p>
          )}
          {admin && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {current.status !== "removing" && (
                <Button variant="secondary" onClick={() => setPreferences(true)}>
                  {copy.defaults}
                </Button>
              )}
              {current.status !== "ready" && (
                <Button variant="secondary" onClick={() => void retry()} disabled={mutation.busy}>
                  {copy.retry}
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => setConfirm(true)}
                disabled={mutation.busy || current.status === "removing"}
              >
                {copy.disconnect}
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-card p-4">
          <p className="max-w-xl flex-1 text-sm text-muted-foreground">{copy.empty}</p>
          {admin && (
            <Button variant="secondary" onClick={() => setOpen(true)}>
              <Icon name="plus" />
              {copy.connect}
            </Button>
          )}
        </div>
      )}
      {role.error && (
        <ConnectionNotice
          compact
          title={copy.unavailable}
          message={role.error}
          onRetry={role.refresh}
        />
      )}
      <Modal
        isOpen={open}
        closable={!dialogBusy}
        onClose={() => {
          if (!dialogBusy) setOpen(false);
        }}
        showCloseButton={false}
        width="min(560px, 100%)"
        maxWidth="100%"
      >
        <IngressConnectForm
          serverId={serverId}
          onBusyChange={setDialogBusy}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            resource.refresh();
          }}
        />
      </Modal>
      <Modal
        isOpen={preferences}
        closable={!dialogBusy}
        onClose={() => {
          if (!dialogBusy) setPreferences(false);
        }}
        showCloseButton={false}
        width="min(480px, 100%)"
        maxWidth="100%"
      >
        {current && (
          <IngressPreferences
            connection={current}
            onBusyChange={setDialogBusy}
            onClose={() => setPreferences(false)}
            onSaved={() => {
              setPreferences(false);
              resource.refresh();
            }}
          />
        )}
      </Modal>
      <Modal
        isOpen={confirm}
        closable={!mutation.busy}
        onClose={() => {
          if (!mutation.busy) setConfirm(false);
        }}
        width="min(480px, 100%)"
        maxWidth="100%"
      >
        <div className="p-6 space-y-4">
          <h2 className="text-lg font-semibold">{copy.disconnect}</h2>
          <p className="text-sm text-muted-foreground">{copy.disconnectHint}</p>
          {mutation.error && (
            <p role="alert" className="text-sm text-danger">
              {mutation.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(false)} disabled={mutation.busy}>
              {copy.cancel}
            </Button>
            <Button variant="destructive" onClick={() => void remove()} disabled={mutation.busy}>
              {copy.disconnect}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
