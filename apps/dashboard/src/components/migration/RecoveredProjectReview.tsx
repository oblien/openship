"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dockerMigrationApi, getApiErrorMessage, type OpenshipProjectGroup } from "@/lib/api";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";

export interface RecoveryResult {
  projectId: string;
  name: string;
}

/** Recovery uses its existing records-only API, independently of Docker migration. */
export function RecoveredProjectReview({
  serverId,
  project,
  onBack,
  onOpen,
  result,
  onRecovered,
  isCurrent,
}: {
  serverId: string;
  project: OpenshipProjectGroup;
  onBack: () => void;
  onOpen: (id: string) => void;
  result?: RecoveryResult;
  onRecovered: (result: RecoveryResult) => void;
  isCurrent: () => boolean;
}) {
  const { t } = useI18n();
  const copy = t.migration.reimport;
  const [name, setName] = useState(result?.name ?? project.suggestedName);
  const [busy, setBusy] = useState(false);
  const doneId = result?.projectId;
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const restore = async () => {
    if (pending.current || !serverId || doneId) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await dockerMigrationApi.reimport({
        serverId,
        projectId: project.projectId,
        projectName: name.trim() || undefined,
      });
      if (!isCurrent()) return;
      invalidateProjectCaches(result.projectId);
      onRecovered({ projectId: result.projectId, name: name.trim() || project.suggestedName });
    } catch (reason) {
      if (active.current) setError(getApiErrorMessage(reason, copy.failed));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };

  return (
    <section className="space-y-4 rounded-2xl bg-card p-5" aria-label={copy.review}>
      <div>
        <h3 className="text-base font-semibold text-foreground">
          {doneId ? copy.reimported : copy.review}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">{copy.recoverHint}</p>
      </div>
      <div className="space-y-2">
        <label
          htmlFor={`recover-name-${project.projectId}`}
          className="text-sm font-medium text-foreground"
        >
          {t.migration.wizard.projectName}
        </label>
        <Input
          id={`recover-name-${project.projectId}`}
          variant="filled"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy || !!doneId}
        />
      </div>
      <dl className="space-y-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">{t.migration.discover.servicesTitle}</dt>
          <dd className="text-foreground">{project.services.length}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">{copy.configuration}</dt>
          <dd className="text-foreground">
            {project.hasSnapshot ? copy.snapshot : copy.containerMetadata}
          </dd>
        </div>
      </dl>
      {!!project.domains?.length && (
        <p className="break-words text-sm text-muted-foreground">{project.domains.join(" · ")}</p>
      )}
      {!project.hasSnapshot && !doneId && (
        <p className="text-xs text-muted-foreground">{copy.checkSettings}</p>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-warning-bg p-3 text-sm text-warning">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          {t.migration.wizard.steps.back}
        </Button>
        {doneId ? (
          <Button onClick={() => onOpen(doneId)}>
            {copy.openProject}
            <Icon name="arrow-right" className="rtl:rotate-180" />
          </Button>
        ) : (
          <Button onClick={() => void restore()} disabled={busy || !serverId}>
            {busy && <Icon name="spinner" className="animate-spin" />}
            {busy ? copy.working : copy.action}
          </Button>
        )}
      </div>
    </section>
  );
}
