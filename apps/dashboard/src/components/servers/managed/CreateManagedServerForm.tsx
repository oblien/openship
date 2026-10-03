"use client";

import { useRef, useState } from "react";
import type { CloudWorkspaceSummary } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { systemApi } from "@/lib/api/system";
import { getApiErrorMessage } from "@/lib/api/client";

export function CreateManagedServerForm({
  onCreated,
  onCancel,
  submitLabel,
  autoFocus = true,
}: {
  onCreated: (server: CloudWorkspaceSummary) => void | Promise<void>;
  onCancel?: () => void;
  submitLabel?: string;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const copy = t.billing.workspaces;
  const [name, setName] = useState(copy.defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const created = useRef<CloudWorkspaceSummary | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busyRef.current || !name.trim()) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      created.current ??= await systemApi.createManagedServer({
        name: name.trim(),
      });
      await onCreated(created.current);
    } catch (error) {
      setError(getApiErrorMessage(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-5 rounded-2xl bg-card p-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{copy.create}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
      </div>
      <label className="block space-y-2 text-sm font-medium">
        <span>{t.dashboard.pages.apps.nameLabel}</span>
        <Input
          autoFocus={autoFocus}
          variant="filled"
          value={name}
          placeholder={copy.defaultName}
          maxLength={80}
          required
          disabled={busy || !!created.current}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <p className="text-xs text-muted-foreground">{copy.createHint}</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
            {t.billing.deployGate.close}
          </Button>
        )}
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy && <Icon name="spinner" className="size-4 animate-spin" aria-hidden />}
          {submitLabel ?? copy.continueToPlans}
        </Button>
      </div>
    </form>
  );
}
