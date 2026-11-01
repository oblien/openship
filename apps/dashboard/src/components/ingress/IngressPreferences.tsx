"use client";
import { useCallback, useEffect, useId, useState } from "react";
import type { IngressConnection } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/Switch";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { ingressApi } from "@/lib/api/ingress";
import { useScopedResource, useScopedMutation } from "@/hooks/use-scoped-resource";
import { useDialogFocus } from "@/hooks/useDialogFocus";
export function IngressPreferences({
  connection,
  onClose,
  onSaved,
  onBusyChange,
}: {
  connection: IngressConnection;
  onClose: () => void;
  onSaved: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useI18n(),
    copy = t.ingress,
    id = useId();
  const { dialog, onKeyDown } = useDialogFocus(() => {
    if (!mutation.busy) onClose();
  });
  const [automatic, setAutomatic] = useState(connection.defaultForDomains),
    [protect, setProtect] = useState(Boolean(connection.defaultAccessPolicyId)),
    [policy, setPolicy] = useState(connection.defaultAccessPolicyId ?? "");
  const policies = useScopedResource(
    useCallback(
      () =>
        protect
          ? ingressApi.discover({
              credentialId: connection.credentialId,
              accountId: connection.accountId,
              includePolicies: true,
            })
          : Promise.resolve(null),
      [connection.credentialId, connection.accountId, protect],
    ),
  );
  const mutation = useScopedMutation();
  useEffect(() => {
    onBusyChange?.(mutation.busy);
    return () => onBusyChange?.(false);
  }, [mutation.busy, onBusyChange]);
  async function save() {
    const updated = await mutation.execute(() =>
      ingressApi.update({
        id: connection.id,
        defaultForDomains: automatic,
        defaultAccessPolicyId: protect ? policy : null,
      }),
    );
    if (updated) onSaved();
  }
  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      onKeyDown={onKeyDown}
      tabIndex={-1}
      className="p-6 space-y-5 outline-none"
    >
      <h2 id={`${id}-title`} className="text-lg font-semibold">
        {copy.defaults}
      </h2>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">{copy.autoDomains}</p>
          <p className="mt-1 text-xs text-muted-foreground">{copy.autoDomainsHint}</p>
        </div>
        <Switch ariaLabel={copy.autoDomains} checked={automatic} onChange={setAutomatic} />
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium">{copy.protect}</span>
        <Switch ariaLabel={copy.protect} checked={protect} onChange={setProtect} />
      </div>
      {protect && (
        <div className="space-y-2">
          <label htmlFor={`${id}-policy`} className="text-sm font-medium">
            {copy.policy}
          </label>
          <CustomSelect
            id={`${id}-policy`}
            variant="filled"
            triggerClassName="bg-muted/60 hover:bg-muted"
            value={policy}
            onChange={setPolicy}
            options={(policies.data?.policies ?? []).map((p) => ({ value: p.id, label: p.name }))}
            placeholder={copy.choose}
          />
          <p className="text-xs text-muted-foreground">{copy.protectHint}</p>
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
      <p className="text-xs text-muted-foreground">{copy.existingUnchanged}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={mutation.busy}>
          {copy.cancel}
        </Button>
        <Button onClick={() => void save()} disabled={mutation.busy || (protect && !policy)}>
          {copy.save}
        </Button>
      </div>
    </div>
  );
}
