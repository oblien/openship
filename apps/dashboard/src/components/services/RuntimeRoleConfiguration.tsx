"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import type { RuntimeRoleConfiguration, RuntimeRoleConfigurationInput } from "@repo/contracts";
import { reportCaughtError } from "@repo/core/diagnostics";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { getApiErrorMessage } from "@/lib/api/client";
import { loadRoleConfiguration, applyRoleConfiguration } from "@/lib/api/project-runtime";

type Role = RuntimeRoleConfigurationInput["roles"][number];

/** Keying the editor by account and release discards private drafts and late responses. */
export function RuntimeRoleConfigurationControl({
  projectId,
  deploymentId,
}: {
  projectId: string;
  deploymentId: string;
}) {
  const scope = useCloudResourceKey();
  return (
    <RoleConfigurationEditor
      key={JSON.stringify([scope, projectId, deploymentId])}
      projectId={projectId}
    />
  );
}

function RoleConfigurationEditor({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { t } = useI18n();
  const c = t.projectDetail.runtimeRoles.configuration;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<RuntimeRoleConfiguration | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const live = useRef(true);
  const busy = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      ++epoch.current;
    };
  }, []);
  const load = async () => {
    const request = ++epoch.current;
    setLoading(true);
    setError(null);
    setConfig(null);
    try {
      const { data } = await loadRoleConfiguration(projectId);
      if (!live.current || request !== epoch.current) return;
      setConfig(data);
      setRoles(data.roles.map((role) => ({ ...role })));
    } catch (error) {
      reportCaughtError(error, "dashboard/components/services/RuntimeRoleConfiguration");
      if (live.current && request === epoch.current) setError(getApiErrorMessage(error));
    } finally {
      if (live.current && request === epoch.current) setLoading(false);
    }
  };
  const close = () => {
    if (!busy.current) {
      ++epoch.current;
      setOpen(false);
    }
  };
  const edit = (index: number, patch: Partial<Role>) =>
    setRoles((value) => value.map((role, i) => (i === index ? { ...role, ...patch } : role)));
  const add = (kind: "worker" | "scheduler") => {
    let n = 1;
    while (roles.some((role) => role.name === `${kind}-${n}`)) n++;
    setRoles((value) => [...value, { name: `${kind}-${n}`, kind, command: "", replicas: 1 }]);
  };
  const apply = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy.current || !config?.supported || !config.deploymentId) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const { data } = await applyRoleConfiguration(projectId, {
        expectedDeploymentId: config.deploymentId,
        expectedUpdatedAt: config.updatedAt,
        roles,
      });
      if (live.current) router.push(`/build/${encodeURIComponent(data.deploymentId)}`);
    } catch (error) {
      reportCaughtError(error, "dashboard/components/services/RuntimeRoleConfiguration");
      if (live.current) setError(getApiErrorMessage(error));
    } finally {
      busy.current = false;
      if (live.current) setSaving(false);
    }
  };
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        <Icon name="settings" />
        {c.configure}
      </Button>
      <Modal
        isOpen={open}
        onClose={close}
        closable={!saving}
        showCloseButton={false}
        maxWidth="760px"
        maxHeight="88dvh"
        height="min(88dvh, 820px)"
      >
        <form
          onSubmit={apply}
          role="dialog"
          aria-modal="true"
          aria-labelledby="runtime-role-config-title"
          className="flex h-full min-h-0 flex-col"
        >
          <div className="shrink-0 space-y-2 p-5 pb-4">
            <h2 id="runtime-role-config-title" className="text-base font-medium text-foreground">
              {c.title}
            </h2>
            <p className="text-sm text-muted-foreground">{c.hint}</p>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-5">
            {loading && (
              <p role="status" className="text-sm text-muted-foreground">
                {t.projectDetail.runtimeRoles.checking}
              </p>
            )}
            {error && (
              <div role="alert" className="rounded-xl bg-danger-bg p-3 text-sm text-danger">
                {error}
                {!config && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => void load()}>
                    {c.retry}
                  </Button>
                )}
              </div>
            )}
            {config && !config.supported && (
              <p className="text-sm text-muted-foreground">{config.reason}</p>
            )}
            {config?.supported && (
              <>
                {roles.map((role, index) => (
                  <fieldset
                    key={index}
                    disabled={saving}
                    className="space-y-3 rounded-xl bg-card p-4"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex size-8 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
                        <Icon
                          name={role.kind === "scheduler" ? "clock" : "terminal"}
                          className="size-4"
                        />
                      </span>
                      <span className="flex-1 text-sm font-medium text-foreground">
                        {t.projectDetail.runtimeRoles[role.kind]}
                      </span>
                      {(role.kind === "scheduler" || role.singleton) && (
                        <span className="rounded-lg bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
                          {c.singleton}
                        </span>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`${c.remove}: ${role.name}`}
                        onClick={() => setRoles((value) => value.filter((_, i) => i !== index))}
                      >
                        <Icon name="trash" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_110px]">
                      <label className="space-y-1.5 text-xs text-muted-foreground">
                        {c.name}
                        <Input
                          variant="filled"
                          value={role.name}
                          required
                          maxLength={63}
                          pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
                          dir="ltr"
                          onChange={(e) => edit(index, { name: e.target.value })}
                        />
                      </label>
                      <label className="space-y-1.5 text-xs text-muted-foreground">
                        {c.replicas}
                        <Input
                          variant="filled"
                          type="number"
                          value={role.replicas ?? 1}
                          min={1}
                          max={role.kind === "scheduler" || role.singleton ? 1 : 100}
                          required
                          disabled={role.kind === "scheduler" || role.singleton}
                          onChange={(e) => edit(index, { replicas: Number(e.target.value) })}
                        />
                      </label>
                    </div>
                    <label className="block space-y-1.5 text-xs text-muted-foreground">
                      {c.command}
                      <Input
                        variant="filled"
                        value={role.command}
                        required
                        maxLength={1000}
                        dir="ltr"
                        className="font-mono"
                        onChange={(e) => edit(index, { command: e.target.value })}
                      />
                    </label>
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer py-1">{c.advanced}</summary>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <label className="space-y-1.5">
                          {c.healthCommand}
                          <Input
                            variant="filled"
                            dir="ltr"
                            value={role.health?.command ?? ""}
                            maxLength={1000}
                            onChange={(e) =>
                              edit(index, {
                                health: e.target.value
                                  ? { kind: "exec", command: e.target.value }
                                  : { kind: "process" },
                              })
                            }
                          />
                        </label>
                        <label className="space-y-1.5">
                          {c.stopGrace}
                          <Input
                            variant="filled"
                            dir="ltr"
                            value={role.stopGracePeriod ?? ""}
                            placeholder="30s"
                            maxLength={32}
                            onChange={(e) =>
                              edit(index, { stopGracePeriod: e.target.value || undefined })
                            }
                          />
                        </label>
                      </div>
                    </details>
                  </fieldset>
                ))}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={saving || roles.length >= 20}
                    onClick={() => add("worker")}
                  >
                    <Icon name="plus" />
                    {c.addWorker}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={saving || roles.length >= 20}
                    onClick={() => add("scheduler")}
                  >
                    <Icon name="plus" />
                    {c.addScheduler}
                  </Button>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{c.sourceHint}</p>
              </>
            )}
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-t border-border/40 p-4">
            <Button type="button" variant="ghost" disabled={saving} onClick={close}>
              {c.cancel}
            </Button>
            {config?.supported && (
              <Button type="submit" disabled={saving || loading}>
                {saving && <Icon name="refresh" className="animate-spin" />}
                {saving ? c.applying : c.apply}
              </Button>
            )}
          </div>
        </form>
      </Modal>
    </>
  );
}
